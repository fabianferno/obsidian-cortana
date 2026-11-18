// vault/repair.ts - the engine's whole-board repair, checked before it lands.
//
// The engine may not edit the board file directly (a stray edit is how line-number
// prefixes and shifted ids got into a real board). For damage edit_task cannot
// reach, it reads the file and sends back the whole corrected board. The plugin
// writes it only if no card, id, column, frontmatter or settings would be lost
// and no known damage is left, keeps the old version for /undoboard, and mints
// ids for cards that came back without one.

import { existsSync, readFileSync } from 'fs';
import { boardFile, getLayout } from '../config/paths.js';
import { ensureCardIds } from './writer.js';
import type { VaultOps } from './ops.js';

export interface BoardBackup {
  /** The board before the repair. */
  before: string;
  /** The board right after the repair (ids minted). Undo only applies while it is still this. */
  after: string;
}

export type RepairResult =
  | { ok: true; changed: boolean; backup: BoardBackup }
  | { ok: false; problems: string[] };

const CARD_LINE = /^\s*-\s*\[[ xX]\]\s+(.+)$/;
/** A checkbox anywhere in the line, so damaged lines ("\t50|- [ ] x") count as cards too. */
const CARD_ANYWHERE = /-\s*\[[ xX]\]\s+(.+)$/;
const TRAILING_IDS = /(?:\s\^[A-Za-z0-9-]+)+\s*$/;
const SETTINGS_MARK = /%%\s*kanban:settings/;
const SETTINGS_JSON = /^\s*\{"kanban-plugin".*\}\s*$/;

interface Card { body: string; ids: string[]; key: string }

function card(body: string): Card {
  const tail = body.match(TRAILING_IDS)?.[0] ?? '';
  const ids = [...tail.matchAll(/\^([A-Za-z0-9-]+)/g)].map(m => m[1]);
  const key = body
    .replace(TRAILING_IDS, '')
    .replace(/^(?:-\s*\[[ xX]\]\s*)+/, '')
    .replace(/@@?\{[^}]*\}/g, '')
    .replace(/\s*—\s*paused:.*$/, '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return { body: body.replace(TRAILING_IDS, '').trim(), ids, key };
}

function cards(content: string, pattern: RegExp): Card[] {
  return content.split('\n').flatMap(line => {
    const m = line.match(pattern);
    return m ? [card(m[1])] : [];
  });
}

const headers = (content: string) =>
  content.split('\n').map(l => l.trim().match(/^## (.+)$/)?.[1].trim()).filter((h): h is string => !!h);

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);

/** What a proposed board would lose or still get wrong. Empty means it is safe to write. */
export function checkBoardRepair(before: string, after: string): string[] {
  const problems: string[] = [];
  const now = cards(after, CARD_LINE);
  const nowIds = new Set(now.flatMap(c => c.ids));

  // Every card survives: by one of its ids, or (no id) by its words.
  for (const c of cards(before, CARD_ANYWHERE)) {
    const kept = c.ids.length > 0
      ? c.ids.some(id => nowIds.has(id))
      : !c.key || now.some(n => n.key.includes(c.key));
    if (!kept) problems.push(`the card "${short(c.body)}" would be lost`);
  }
  const nowHeaders = new Set(headers(after));
  for (const h of headers(before)) if (!nowHeaders.has(h)) problems.push(`the "${h}" column would be lost`);
  if (/kanban-plugin:\s*\S/.test(before) && !/kanban-plugin:\s*\S/.test(after)) problems.push('the frontmatter would be lost');

  const json = before.split('\n').filter(l => SETTINGS_JSON.test(l)).map(l => l.trim());
  if (json.length > 0 && !after.split('\n').some(l => json.includes(l.trim()))) problems.push('the Kanban settings would be lost');
  if (after.split('\n').filter(l => SETTINGS_MARK.test(l)).length > 1) problems.push('there is more than one settings block');

  // Damage that must not survive a repair.
  if (after.split('\n').some(l => /^\s*\d+\|/.test(l))) problems.push('line-number prefixes ("12|") are still in it');
  if (after.split('\n').some(l => /-\s*\[[ xX]\]\s+-\s*\[[ xX]\]/.test(l))) problems.push('a doubled checkbox ("- [ ] - [ ]") is still in it');
  for (const c of now) if (c.ids.length > 1) problems.push(`"${short(c.body)}" has two ids`);
  const seen = new Set<string>();
  for (const id of now.flatMap(c => c.ids)) {
    if (seen.has(id)) problems.push(`the id ^${id} is on more than one card`);
    seen.add(id);
  }
  return problems;
}

/** Writes the engine's corrected board if it passes the checks against the board as it is now. */
export async function repairBoard(ops: VaultOps, vaultPath: string, proposed: string): Promise<RepairResult> {
  const file = boardFile(vaultPath);
  if (!existsSync(file)) return { ok: false, problems: [`there is no board at ${getLayout().boardPath}`] };
  let after = proposed.replace(/\r\n/g, '\n');
  let before = '';
  let problems: string[] = [];
  await ops.process(getLayout().boardPath, current => {
    before = current;
    if (current.endsWith('\n') && !after.endsWith('\n')) after += '\n';
    problems = checkBoardRepair(current, after);
    return problems.length > 0 ? current : after;
  });
  if (problems.length > 0) return { ok: false, problems };
  if (before === after) return { ok: true, changed: false, backup: { before, after } };
  await ensureCardIds(ops, vaultPath);
  return { ok: true, changed: true, backup: { before, after: readFileSync(file, 'utf-8') } };
}

/** Puts the pre-repair board back, only if nothing changed on the board since the repair. */
export async function undoBoardRepair(ops: VaultOps, vaultPath: string, backup: BoardBackup): Promise<boolean> {
  if (!existsSync(boardFile(vaultPath))) return false;
  let restored = false;
  await ops.process(getLayout().boardPath, current => {
    restored = current === backup.after;
    return restored ? backup.before : current;
  });
  return restored;
}
