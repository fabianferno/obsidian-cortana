// mcp/tools.ts - what other AIs (Claude Code, Codex, Cursor, Gemini CLI...) can do
// with the vault through Cortana's MCP server.
//
// Reads use the same lookups as the agent (search and findNote skip the daily notes
// and the agent folder). Writes are agent actions run through executeVaultActions,
// so outside AIs get the tested writers and the same rules as Cortana's own engine:
// the user's lines are never rewritten, the board keeps its format, nothing touches
// the daily notes, and the personality files are not reachable at all.

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { agentDir, boardFile, getLayout } from '../config/paths.js';
import { loadAgentConfig } from '../config/loader.js';
import { getVaultState } from '../context/vault-state.js';
import { getDateTimeContext } from '../context/datetime.js';
import { parseInboxKanban } from '../vault/parser.js';
import { searchNotesWithContent } from '../vault/search.js';
import { findNote, listNotes } from '../vault/notes.js';
import { isValidAction, describeActions } from '../brain/actions.js';
import { executeVaultActions } from '../agent/execute-actions.js';
import { addChange, type NoteChange } from '../agent/changes.js';
import type { VaultOps } from '../vault/ops.js';
import type { Store } from '../store/store.js';
import type { JsonObject } from '../utils/json.js';

export interface ToolContext {
  vaultPath: string;
  ops: VaultOps;
  store: Store;
  /** The connected AI, as it named itself ("Claude Code"). Written as the source of what it files. */
  client: string;
  /** Called after a write, with who did it, a one-line summary and the notes it touched. */
  onWrite?: (client: string, summary: string, changes: NoteChange[]) => void;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  /** True for tools that change the vault. Hidden when the user allows reading only. */
  writes: boolean;
  run(args: JsonObject, ctx: ToolContext): Promise<string>;
}

/** A failure the calling AI should see and can act on (bad input, card not found). */
export class ToolError extends Error {}

const MAX_NOTE_CHARS = 20000;
const MAX_CARDS_PER_COLUMN = 30;

function str(args: JsonObject, key: string, required = true): string {
  const v = args[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (required) throw new ToolError(`"${key}" is required.`);
  return '';
}

/** Runs one agent action through the tested writers and reports what happened. */
async function act(action: JsonObject, ctx: ToolContext): Promise<string> {
  if (!isValidAction(action)) throw new ToolError('Some required fields are missing or invalid.');
  let changes: NoteChange[] = [];
  const results = await executeVaultActions(ctx.vaultPath, ctx.ops, ctx.store, [action], c => { changes = addChange(changes, c); });
  const failed = results.find(r => !r.ok);
  if (failed) throw new ToolError(failed.text);
  const summary = results.map(r => r.text).join(' ') || describeActions([action]) || 'Done.';
  ctx.onWrite?.(ctx.client, summary, changes);
  return summary;
}

function boardSection(vaultPath: string): string {
  const file = boardFile(vaultPath);
  if (!existsSync(file)) return `No board: there is no Kanban note at "${getLayout().boardPath}".`;
  const board = parseInboxKanban(readFileSync(file, 'utf-8'));
  return board.columnOrder.map(col => {
    if (col === 'Done') return '';
    const cards = board.columns[col] ?? [];
    const shown = cards.slice(0, MAX_CARDS_PER_COLUMN).map(t => `  - ${t.text}${t.dueDate ? ` (due ${t.dueDate})` : ''}`);
    const more = cards.length > shown.length ? `\n  - ...and ${cards.length - shown.length} more` : '';
    return `- ${col} (${cards.length})${shown.length ? `\n${shown.join('\n')}` : ''}${more}`;
  }).filter(Boolean).join('\n');
}

export const TOOLS: Tool[] = [
  {
    name: 'get_context',
    title: 'Who the user is and what they are working on',
    description: 'Call this first in a conversation. Returns what Cortana knows about the user (profile, goals, remembered facts), today\'s date and their Kanban board: what they are doing now, what is next, overdue and due soon. Use it to answer as someone who knows them.',
    inputSchema: { type: 'object', properties: {} },
    writes: false,
    async run(_args, ctx) {
      const config = loadAgentConfig(agentDir(ctx.vaultPath));
      const dt = getDateTimeContext(config.userMeta.timezone);
      const v = await getVaultState(ctx.vaultPath, ctx.store);
      const list = (tasks: { text: string; dueDate?: string }[]) => tasks.map(t => `${t.text}${t.dueDate ? ` (due ${t.dueDate})` : ''}`).join('; ') || 'none';
      return [
        `# Now\n${dt.now} (${dt.dayOfWeek}, ${dt.timeOfDay})`,
        `# About the user\n${config.user.trim() || '(not filled in yet)'}`,
        `# Goals\n${config.goals.trim() || '(none written yet)'}`,
        `# Remembered (newest first)\n${config.memory.slice(0, 40).map(m => `- ${m}`).join('\n') || '- nothing yet'}`,
        `# Board\n${boardSection(ctx.vaultPath)}\n- Done today: ${list(v.doneToday)}\n- Overdue: ${list(v.overdueTasks)}\n- Due in 3 days: ${list(v.dueSoon)}`,
        '# How to use this vault\n- search_notes and read_note find what the user wrote. Daily notes are private and not available.\n- To file something the user tells you (a person, project, idea, decision), use capture_note. It adds a dated line and never changes what the user wrote.\n- Use remember for lasting facts about the user, and add_task / move_task for the board.',
      ].join('\n\n');
    },
  },
  {
    name: 'search_notes',
    title: 'Search the user\'s notes',
    description: 'Full-text and title search across the user\'s Obsidian notes (not their daily notes). Returns the best matches with their path, tags and a snippet. Use read_note to open one.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for.' },
        limit: { type: 'number', description: 'How many results, 1 to 10. Default 5.' },
      },
      required: ['query'],
    },
    writes: false,
    async run(args, ctx) {
      const limit = typeof args.limit === 'number' ? Math.min(10, Math.max(1, Math.round(args.limit))) : 5;
      const hits = searchNotesWithContent(ctx.vaultPath, str(args, 'query'), { limit, maxContentChars: 0 });
      if (!hits.length) return 'No notes matched.';
      return hits.map(h => `## ${h.fileName}\npath: ${h.filePath.split(path.sep).join('/')}${h.tags.length ? `\ntags: ${h.tags.join(', ')}` : ''}\n${h.snippet}`).join('\n\n');
    },
  },
  {
    name: 'read_note',
    title: 'Read one note',
    description: 'Returns the full text of a note, found by its title, one of its aliases, or its path from search_notes. Daily notes and Cortana\'s own files are not available.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'A note title, alias, or vault path such as "Projects/Cortana.md".' } },
      required: ['note'],
    },
    writes: false,
    async run(args, ctx) {
      const want = str(args, 'note');
      let file = findNote(ctx.vaultPath, want.replace(/\.md$/i, ''));
      if (!file && want.toLowerCase().endsWith('.md')) {
        // A path is accepted only if it is one of the notes the agent may read.
        const abs = path.resolve(ctx.vaultPath, want);
        file = listNotes(ctx.vaultPath).find(p => p === abs) ?? null;
      }
      if (!file) throw new ToolError(`No note called "${want}". Try search_notes.`);
      const text = readFileSync(file, 'utf-8');
      const rel = path.relative(ctx.vaultPath, file).split(path.sep).join('/');
      return `path: ${rel}\n\n${text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS)}\n\n[cut at ${MAX_NOTE_CHARS} characters]` : text}`;
    },
  },
  {
    name: 'capture_note',
    title: 'File something in the user\'s notes',
    description: 'Records something the user told you about a person, project, idea or decision. If a note with that title or alias exists, a dated line is added to its Timeline (the user\'s own text is never changed). Otherwise a new note is created in the capture folder, where Cortana tidies it later. Use the user\'s words.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The note\'s name: the person, project or idea, e.g. "Maria Silva".' },
        text: { type: 'string', description: 'What to record, one or two sentences in the user\'s words.' },
        type: { type: 'string', description: 'The kind of note, as a lowercase tag: people, projects, concept, decision... Used only when a new note is created.' },
      },
      required: ['title', 'text', 'type'],
    },
    writes: true,
    run: (args, ctx) => act({ type: 'note', title: str(args, 'title'), text: str(args, 'text'), noteType: str(args, 'type'), source: ctx.client }, ctx),
  },
  {
    name: 'remember',
    title: 'Remember a fact about the user',
    description: 'Saves a lasting fact or preference about the user to Cortana\'s memory, which every AI connected to this vault sees through get_context. For things about the user themselves, not about other people or projects (use capture_note for those).',
    inputSchema: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'One short sentence, e.g. "Prefers calls after 4pm".' } },
      required: ['fact'],
    },
    writes: true,
    run: (args, ctx) => act({ type: 'update_memory', observation: `${str(args, 'fact')} (via ${ctx.client})` }, ctx),
  },
  {
    name: 'add_task',
    title: 'Add a card to the board',
    description: 'Adds a card to a column of the user\'s Kanban board. Column names are listed by get_context.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The card text.' },
        column: { type: 'string', description: 'The column. Default "To Do".' },
      },
      required: ['text'],
    },
    writes: true,
    run: (args, ctx) => act({ type: 'add_task', text: str(args, 'text'), column: str(args, 'column', false) || 'To Do' }, ctx),
  },
  {
    name: 'move_task',
    title: 'Move a card on the board',
    description: 'Moves a card between columns of the user\'s Kanban board, for example to "Doing" or "Done". Use the card text and columns from get_context.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The card text, as on the board.' },
        from: { type: 'string', description: 'The column it is in now.' },
        to: { type: 'string', description: 'The column to move it to.' },
      },
      required: ['task', 'from', 'to'],
    },
    writes: true,
    run: (args, ctx) => act({ type: 'move_task', task: str(args, 'task'), from: str(args, 'from'), to: str(args, 'to') }, ctx),
  },
];

/** The tools offered, in the shape MCP's tools/list returns. */
export function listTools(allowWrites: boolean): JsonObject[] {
  return TOOLS.filter(t => allowWrites || !t.writes).map(t => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: !t.writes, destructiveHint: false, openWorldHint: false },
  }));
}
