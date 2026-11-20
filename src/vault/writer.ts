// vault/writer.ts

import { existsSync, readFileSync } from 'fs';
import type { KanbanMutation } from '../config/types.js';
import { applyConfigEdit } from '../config/editor.js';
import { parseInboxKanban } from './parser.js';
import { mintCardId } from './card-id.js';
import { createLogger } from '../utils/logger.js';
import { boardFile, getLayout } from '../config/paths.js';
import type { VaultOps } from './ops.js';

const logger = createLogger('writer');

/** An empty board in the Kanban plugin's format; it is also a plain note without the plugin. */
export const STARTER_BOARD = `---

kanban-plugin: board

---

## Backlog



## To Do



## Doing



## Done




%% kanban:settings
\`\`\`
{"kanban-plugin":"board","list-collapse":[false,false,false,false]}
\`\`\`
%%
`;

/** Creates the board at the configured path. False when one is already there (it is never overwritten). */
export async function createBoard(ops: VaultOps, vaultPath: string): Promise<boolean> {
  if (existsSync(boardFile(vaultPath))) return false;
  let created = false;
  await ops.process(getLayout().boardPath, content => {
    if (content) return content;
    created = true;
    return STARTER_BOARD;
  });
  return created;
}

/** Read-modify-write the board through VaultOps. A missing board is an error, never created. */
async function processBoard(ops: VaultOps, vaultPath: string, edit: (content: string) => string): Promise<void> {
  if (!existsSync(boardFile(vaultPath))) throw new Error(`No board at ${getLayout().boardPath}`);
  await ops.process(getLayout().boardPath, edit);
}

/** Collect all block-ref ids currently present on the board. */
function collectExistingIds(content: string): Set<string> {
  const board = parseInboxKanban(content);
  const existing = new Set<string>();
  for (const col of Object.values(board.columns)) {
    for (const t of col) if (t.id) existing.add(t.id);
  }
  return existing;
}

/**
 * Append a block-ref id (` ^xxxxxx`) to every checklist line that lacks one.
 * Writes the board in place. Returns the newly minted ids. Idempotent.
 */
export async function ensureCardIds(ops: VaultOps, vaultPath: string): Promise<string[]> {
  let minted: string[] = [];
  await processBoard(ops, vaultPath, content => {
    const existing = collectExistingIds(content);
    minted = [];
    const out = content.split('\n').map(line => {
      const m = line.match(/^(\s*-\s*\[[ xX]\]\s+)(.+?)(\s*)$/);
      if (!m) return line;
      const body = m[2];
      if (/\s\^[A-Za-z0-9-]+$/.test(body)) return line; // already has an id
      const id = mintCardId(existing);
      minted.push(id);
      return `${m[1]}${body} ^${id}`;
    });
    return minted.length > 0 ? out.join('\n') : content;
  });
  return minted;
}

/**
 * Apply mutations to the board. Returns true only if the file content actually
 * changed. A move whose `from` column is wrong, or whose task text matches
 * nothing, is a silent no-op otherwise: this return value lets callers tell the
 * user "moved it" only when a move really happened, instead of claiming a write
 * that never landed (the exact failure that made the agent narrate phantom moves).
 */
export async function mutateKanban(ops: VaultOps, vaultPath: string, mutations: KanbanMutation[]): Promise<boolean> {
  let changed = false;
  await processBoard(ops, vaultPath, original => {
    const content = applyMutations(original, mutations);
    changed = content !== original;
    return content;
  });
  return changed;
}

function applyMutations(original: string, mutations: KanbanMutation[]): string {
  let content = original;
  for (const mutation of mutations) {
    if (!mutation.task) continue; // skip if LLM returned empty/undefined task
    switch (mutation.type) {
      case 'move':
        content = moveTask(content, mutation.task, mutation.fromColumn!, mutation.toColumn!);
        break;
      case 'add':
        content = addTask(content, mutation.task, mutation.toColumn!);
        break;
      case 'remove':
        content = removeTask(content, mutation.task, mutation.fromColumn!).content;
        break;
      case 'edit':
        content = editTask(content, mutation.task, mutation.newText!);
        break;
    }
  }

  return content;
}

/**
 * Relocate every checked-off card (`- [x]`) sitting in a non-terminal column
 * into Done. In Obsidian Kanban, ticking a card's checkbox marks it complete
 * *in place*; it does not move the card to the Done column. Left alone, completed
 * cards pile up under To Do/Doing and the agent keeps surfacing them as live work
 * (the parser reports column and completed state independently). This heals that:
 * each card's exact line is moved verbatim -- block-ref id, date, and pause note
 * intact -- to the bottom of the Done column, so its stable id survives (unlike
 * the text-matching move path, which re-mints one). Returns the moved card texts.
 * Idempotent: Done/Archive are terminal, so a healed card is never moved again.
 */
export async function autoMoveCompletedToDone(ops: VaultOps, vaultPath: string): Promise<string[]> {
  let texts: string[] = [];
  await processBoard(ops, vaultPath, content => {
    const r = moveCompletedToDone(content);
    texts = r.moved;
    return r.content;
  });
  return texts;
}

function moveCompletedToDone(content: string): { content: string; moved: string[] } {
  const lines = content.split('\n');

  const TERMINAL = new Set(['Done', 'Archive']);
  const moved: { line: string; text: string }[] = [];
  const kept: string[] = [];
  let column = '';

  // Pass 1: lift completed cards out of every non-terminal column.
  for (const line of lines) {
    const header = line.trim().match(/^## (.+)$/);
    if (header) {
      column = header[1].trim();
      kept.push(line);
      continue;
    }
    const task = line.match(/^\s*-\s*\[[xX]\]\s+(.+)$/);
    if (task && column && !TERMINAL.has(column)) {
      moved.push({ line, text: normalizeTaskBody(task[1]) });
      continue; // drop from source column
    }
    kept.push(line);
  }

  if (moved.length === 0) return { content, moved: [] };

  // Pass 2: drop the lifted cards at the end of the Done column. Done is followed
  // by the ## Archive header in this vault, so the next-header boundary flushes
  // them at the bottom of Done; the trailing flush covers a board where Done is
  // the last column.
  const out: string[] = [];
  let inDone = false;
  for (const line of kept) {
    const header = line.trim().match(/^## (.+)$/);
    if (header) {
      if (inDone) for (const m of moved) out.push(m.line);
      inDone = header[1].trim() === 'Done';
    }
    out.push(line);
  }
  if (inDone) for (const m of moved) out.push(m.line);

  return { content: out.join('\n'), moved: moved.map(m => m.text) };
}

/**
 * Count the checklist cards (`- [ ]` / `- [x]`) sitting under the given columns.
 * Read-only; used to tell the user how many cards `clearColumns` would delete
 * before they confirm. Column names are matched exactly against `## Header` lines.
 */
export function countColumnCards(vaultPath: string, columns: string[]): number {
  const inboxPath = boardFile(vaultPath);
  const targets = new Set(columns);
  let column = '';
  let count = 0;
  for (const line of readFileSync(inboxPath, 'utf-8').split('\n')) {
    const header = line.trim().match(/^## (.+)$/);
    if (header) { column = header[1].trim(); continue; }
    if (targets.has(column) && /^\s*-\s*\[[ xX]\]\s+/.test(line)) count++;
  }
  return count;
}

/**
 * Delete every checklist card (`- [ ]` / `- [x]`) under the given columns,
 * leaving the column headers and all other columns untouched. Used by the
 * `/clearboard` admin command to empty the terminal Done/Archive columns.
 * Returns the number of cards removed; a no-op returns 0 without rewriting.
 */
export async function clearColumns(ops: VaultOps, vaultPath: string, columns: string[]): Promise<number> {
  const targets = new Set(columns);
  let removed = 0;
  await processBoard(ops, vaultPath, content => {
    let column = '';
    removed = 0;
    const kept = content.split('\n').filter(line => {
      const header = line.trim().match(/^## (.+)$/);
      if (header) { column = header[1].trim(); return true; }
      if (targets.has(column) && /^\s*-\s*\[[ xX]\]\s+/.test(line)) { removed++; return false; }
      return true;
    });
    return removed > 0 ? kept.join('\n') : content;
  });
  return removed;
}

/** The column a checklist card with this body currently sits in, or null. */
function findTaskColumn(content: string, taskText: string): string | null {
  const lines = content.split('\n');
  let column: string | null = null;
  const want = normalizeForMatch(taskText);
  for (const line of lines) {
    if (line.trim().startsWith('## ')) {
      column = line.trim().slice(3);
      continue;
    }
    const m = line.match(/^\s*-\s*\[[ xX]\]\s+(.+)$/);
    if (m && column && normalizeForMatch(m[1]) === want) return column;
  }
  return null;
}

function moveTask(content: string, taskText: string, from: string, to: string): string {
  // The model often supplies the wrong `from` column (it guesses from stale
  // context). Removing from a column the card is not in is a silent no-op that
  // leaves the card where it was, so trust where the card actually is over the
  // claimed source.
  const source = columnHasTask(content, from, taskText) ? from : findTaskColumn(content, taskText);
  // Card is nowhere on the board: do NOT fabricate one in the destination.
  // A move must relocate an existing card, never conjure a phantom (which is how
  // "clear the finvoice" could otherwise invent a Done card that never existed).
  if (!source || source === to) return content;
  // No such destination column: leave the card where it is instead of dropping it.
  if (!content.split('\n').some(l => l.trim() === `## ${to}`)) return content;
  // Move the card's own line, so its date, pause note and block id travel with it.
  const { content: result, body } = removeTask(content, taskText, source);
  return body ? addTask(result, body, to) : content;
}

/** Strip wikilink brackets so cleaned text from the parser matches raw lines containing [[...]]. */
function normalizeTaskBody(s: string): string {
  return s
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s*\^[A-Za-z0-9-]+\s*$/, '') // ignore trailing block-ref id when matching
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a task body for TITLE MATCHING. Same as normalizeTaskBody but also
 * strips the Obsidian Kanban date/time stamps (@{YYYY-MM-DD}, @@{HH:MM}), so a
 * caller saying "move Meet with mountroof to Done" matches the card
 * "Meet with mountroof @{2026-07-16}". Kept separate from normalizeTaskBody
 * because that function's output is also surfaced verbatim (e.g. move logs),
 * where the date should be preserved.
 */
function normalizeForMatch(s: string): string {
  return normalizeTaskBody(s)
    .replace(/@\{\d{4}-\d{2}-\d{2}\}/g, '')
    .replace(/@@\{\d{2}:\d{2}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if the column already has a checklist line with the same task body (avoids duplicate adds). */
function columnHasTask(content: string, column: string, taskText: string): boolean {
  const lines = content.split('\n');
  let inColumn = false;
  const want = normalizeForMatch(taskText);
  for (const line of lines) {
    if (line.trim().startsWith('## ')) {
      inColumn = line.trim() === `## ${column}`;
      continue;
    }
    if (!inColumn) continue;
    const m = line.match(/^\s*-\s*\[[ xX]\]\s+(.+)$/);
    if (m && normalizeForMatch(m[1]) === want) return true;
  }
  return false;
}

function addTask(content: string, taskText: string, column: string): string {
  if (columnHasTask(content, column, taskText)) return content;

  const columnHeader = `## ${column}`;
  const idx = content.indexOf(columnHeader);
  if (idx === -1) return content;

  const afterHeader = content.slice(idx + columnHeader.length);
  const nextColumnIdx = afterHeader.search(/\n## /);
  const insertPoint = nextColumnIdx === -1
    ? content.length
    : idx + columnHeader.length + nextColumnIdx;

  // Ensure the added card carries a block-ref id
  let bodyWithId = taskText;
  if (!/\s\^[A-Za-z0-9-]+$/.test(taskText)) {
    bodyWithId = `${taskText} ^${mintCardId(collectExistingIds(content))}`;
  }
  const taskLine = `\n- [ ] ${bodyWithId}`;
  return content.slice(0, insertPoint) + taskLine + content.slice(insertPoint);
}

/** Removes the first card in `column` whose title matches, and returns its body (null if none). */
function removeTask(content: string, taskText: string, column: string): { content: string; body: string | null } {
  const lines = content.split('\n');
  const want = normalizeForMatch(taskText);
  let inColumn = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('## ')) {
      inColumn = line.trim() === `## ${column}`;
      continue;
    }
    if (!inColumn) continue;
    const m = line.match(/^\s*-\s*\[[ xX]\]\s+(.+)$/);
    if (m && normalizeForMatch(m[1]) === want) {
      lines.splice(i, 1);
      return { content: lines.join('\n'), body: m[1].trimEnd() };
    }
  }
  return { content, body: null };
}

function editTask(content: string, oldText: string, newText: string): string {
  return content.replace(
    new RegExp(`(- \\[[ xX]\\] )${escapeRegex(oldText)}`),
    `$1${newText}`,
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rewrite the @{date}/@@{time} of the card whose line ends with ` ^cardId`. */
export async function updateCardDeadlineById(ops: VaultOps, vaultPath: string, cardId: string, date: string, time: string | null): Promise<void> {
  const tail = new RegExp(`\\s\\^${cardId}\\s*$`);
  await processBoard(ops, vaultPath, content => content.split('\n').map(line => {
    if (!tail.test(line)) return line;
    // Strip any existing date/time annotations, then re-insert before the id.
    const stripped = line
      .replace(/@\{\d{4}-\d{2}-\d{2}\}/, '')
      .replace(/@@\{\d{2}:\d{2}\}/, '')
      .replace(/\s{2,}/g, ' ');
    const ann = time ? `@{${date}} @@{${time}}` : `@{${date}}`;
    return stripped.replace(new RegExp(`\\s\\^${cardId}\\s*$`), ` ${ann} ^${cardId}`);
  }).join('\n'));
}

/** Strip date/time/wikilink/id decoration so an LLM-supplied title matches a raw card line. */
function normalizeCardTitle(s: string): string {
  return s
    .replace(/@\{\d{4}-\d{2}-\d{2}\}/g, '')
    .replace(/@@\{\d{2}:\d{2}\}/g, '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s*\^[A-Za-z0-9-]+\s*$/, '')
    .replace(PAUSE_NOTE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The pause note the focus tracker appends to a card: " -- paused: <why>" (em dash). */
const PAUSE_NOTE = /\s*—\s*paused:.*$/;
const LEADING_CHECKBOXES = /^(?:-\s*\[[ xX]\]\s*)+/;

export type EditCardResult = 'edited' | 'unchanged' | 'not_found' | 'ambiguous' | 'empty';

/**
 * Rewrite the text of the one card whose title matches `title`, in place: same
 * column, checkbox, date, time, pause note and block id. Used to fix typos and
 * badly formatted cards ("- [ ] - [ ] X"). Exact title matches only, and a title
 * that matches more than one card changes nothing, since an edit replaces words.
 */
export async function editCardText(ops: VaultOps, vaultPath: string, title: string, newText: string): Promise<EditCardResult> {
  let result: EditCardResult = 'not_found';
  await processBoard(ops, vaultPath, content => {
    const out = editByTitle(content, title, newText);
    result = out.result;
    return out.content;
  });
  return result;
}

function editByTitle(content: string, title: string, newText: string): { content: string; result: EditCardResult } {
  const key = (s: string) => normalizeCardTitle(s).replace(LEADING_CHECKBOXES, '').trim();
  const want = key(title);
  if (!want) return { content, result: 'not_found' };
  const lines = content.split('\n');
  const hits: number[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*-\s*\[[ xX]\]\s+(.+)$/);
    if (m && key(m[1]) === want) hits.push(i);
  });
  if (hits.length === 0) return { content, result: 'not_found' };
  if (hits.length > 1) return { content, result: 'ambiguous' };

  const [, indent, check, oldBody] = lines[hits[0]].match(/^(\s*)-\s*\[([ xX])\]\s+(.+?)\s*$/)!;
  let rest = oldBody;
  const id = rest.match(/\s\^([A-Za-z0-9-]+)$/)?.[1];
  if (id) rest = rest.replace(/\s\^[A-Za-z0-9-]+$/, '');
  const pause = rest.match(PAUSE_NOTE)?.[0].trim();
  if (pause) rest = rest.replace(PAUSE_NOTE, '');

  // One line, no checkbox prefix, no id of its own (the card keeps its id).
  let text = newText.replace(/\s+/g, ' ').trim()
    .replace(LEADING_CHECKBOXES, '')
    .replace(/(^|\s)\^[A-Za-z0-9-]+$/, '')
    .trim();
  if (!text.replace(/@@?\{[^}]*\}/g, '').trim()) return { content, result: 'empty' };

  // The engine sees card text without [[ ]]: put back the links it kept as plain words.
  for (const [link, target] of rest.matchAll(/\[\[([^\]]+)\]\]/g)) {
    if (!text.includes(link) && text.includes(target)) text = text.replace(target, link);
  }
  const date = rest.match(/@\{\d{4}-\d{2}-\d{2}\}/)?.[0];
  const time = rest.match(/@@\{\d{2}:\d{2}\}/)?.[0];
  const parts = [
    text,
    date && !/(^|[^@])@\{/.test(text) ? date : '',
    time && !text.includes('@@{') ? time : '',
    pause ?? '',
    id ? `^${id}` : '',
  ].filter(Boolean);
  const line = `${indent}- [${check}] ${parts.join(' ')}`;
  if (line === lines[hits[0]]) return { content, result: 'unchanged' };
  lines[hits[0]] = line;
  return { content: lines.join('\n'), result: 'edited' };
}

/**
 * Rewrite the @{date} (and optional @@{time}) of the board card whose title
 * matches `title`, resolving by fuzzy title the way the calendar search did.
 * Returns true only if a card matched. A user asking to "move it to tomorrow"
 * is a board edit first; the board->calendar sync then propagates the new date
 * to Google Calendar (creating the event if the card had none). Routing a
 * reschedule through the calendar alone silently failed whenever the card had
 * no linked event -- e.g. a past-due card -- while the model still narrated a
 * move that never landed. The board is authoritative here.
 */
export async function updateCardDeadlineByTitle(ops: VaultOps, vaultPath: string, title: string, date: string, time: string | null = null): Promise<boolean> {
  if (!normalizeCardTitle(title)) return false;
  let matched = false;
  await processBoard(ops, vaultPath, content => {
    const next = rescheduleByTitle(content, title, date, time);
    matched = next !== null;
    return next ?? content;
  });
  return matched;
}

/** The board with the matching card's date rewritten, or null when no card matches. */
function rescheduleByTitle(content: string, title: string, date: string, time: string | null): string | null {
  const lines = content.split('\n');
  const want = normalizeCardTitle(title);
  if (!want) return null;

  const bodyOf = (line: string): string | null => {
    const m = line.match(/^\s*-\s*\[[ xX]\]\s+(.+)$/);
    return m ? normalizeCardTitle(m[1]) : null;
  };

  // Prefer exact-title matches; fall back to substring containment only if none
  // match exactly, so a short title can't clobber an unrelated card.
  let candidates = lines.map((l, i) => ({ i, body: bodyOf(l) }))
    .filter(c => c.body !== null && c.body === want);
  if (candidates.length === 0) {
    candidates = lines.map((l, i) => ({ i, body: bodyOf(l) }))
      .filter((c): c is { i: number; body: string } => c.body !== null && (c.body.includes(want) || want.includes(c.body)));
  }
  if (candidates.length === 0) return null;

  // A reschedule targets a card that already carries a date; prefer that over a
  // same-titled dateless twin so we move the real deadline instead of stamping a
  // date onto the wrong card.
  const dated = candidates.find(c => /@\{\d{4}-\d{2}-\d{2}\}/.test(lines[c.i]));
  const target = (dated ?? candidates[0]).i;

  const line = lines[target];
  const idMatch = line.match(/\s(\^[A-Za-z0-9-]+)\s*$/);
  const id = idMatch ? idMatch[1] : null;
  let base = line;
  if (id) base = base.replace(/\s\^[A-Za-z0-9-]+\s*$/, '');
  base = base
    .replace(/@\{\d{4}-\d{2}-\d{2}\}/, '')
    .replace(/@@\{\d{2}:\d{2}\}/, '')
    .replace(/\s{2,}/g, ' ')
    .trimEnd();
  const ann = time ? `@{${date}} @@{${time}}` : `@{${date}}`;
  lines[target] = id ? `${base} ${ann} ${id}` : `${base} ${ann}`;
  return lines.join('\n');
}

/** Remove the card whose line ends with ` ^cardId`. */
export async function deleteCardById(ops: VaultOps, vaultPath: string, cardId: string): Promise<void> {
  const tail = new RegExp(`\\s\\^${cardId}\\s*$`);
  await processBoard(ops, vaultPath, content => content.split('\n').filter(l => !tail.test(l)).join('\n'));
}

/** Adds `entry` as the last line of `sectionHeader` in the vault file at `rel`. */
export async function appendToSection(ops: VaultOps, rel: string, sectionHeader: string, entry: string): Promise<void> {
  await ops.process(rel, content => addToSection(content, sectionHeader, entry));
}

function addToSection(content: string, sectionHeader: string, entry: string): string {
  const lines = content.split('\n');

  const headerIdx = lines.findIndex((l) => l.trimEnd() === sectionHeader);

  // Section not present: add it at the end, separated by one blank line.
  if (headerIdx === -1) return `${content.replace(/\s+$/, '')}\n\n${sectionHeader}\n${entry}\n`;

  // The section runs until the next markdown heading (or end of file).
  let sectionEnd = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) { sectionEnd = i; break; }
  }

  // Insert right after the last non-empty line in the section body, so the new
  // bullet sits directly under the previous one (no stray blank line) while any
  // blank line before the following heading is left intact.
  let insertAfter = headerIdx;
  for (let i = headerIdx + 1; i < sectionEnd; i++) {
    if (lines[i].trim() !== '') insertAfter = i;
  }

  lines.splice(insertAfter + 1, 0, entry);
  return lines.join('\n');
}

export async function appendMemoryEntry(ops: VaultOps, vaultPath: string, observation: string): Promise<void> {
  const date = new Date().toISOString().split('T')[0];

  // Newest-at-top: prompt-builder reads the 20 most recent entries off the front
  // with config.memory.slice(0, 20), so a new entry must land first.
  const result = await applyConfigEdit(ops, vaultPath, {
    file: 'memory.md', section: 'Entries',
    operation: 'prepend_bullet', content: `[${date}] ${observation}`,
  });
  if (!result.ok) logger.warn(`appendMemoryEntry rejected: ${result.reason}`);
}
