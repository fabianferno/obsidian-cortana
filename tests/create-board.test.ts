import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setLayout } from '../src/config/paths.js';
import { fsVaultOps } from '../src/vault/ops.js';
import { createBoard, mutateKanban } from '../src/vault/writer.js';
import { parseInboxKanban } from '../src/vault/parser.js';
import { executeVaultActions } from '../src/agent/execute-actions.js';
import { parseAgentReply } from '../src/brain/actions.js';
import { Store } from '../src/store/store.js';

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'vault-board-'));
  setLayout({ boardPath: 'Planning/Board.md', agentFolder: 'agent', dailyFolder: 'Daily' });
});

afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('createBoard', () => {
  it('makes an empty four-column board that the parser and writer accept', async () => {
    expect(await createBoard(fsVaultOps(vault), vault)).toBe(true);
    const file = path.join(vault, 'Planning', 'Board.md');
    const board = parseInboxKanban(readFileSync(file, 'utf-8'));
    expect(board.columnOrder).toEqual(['Backlog', 'To Do', 'Doing', 'Done']);
    expect(Object.values(board.columns).flat()).toHaveLength(0);

    expect(await mutateKanban(fsVaultOps(vault), vault, [{ type: 'add', task: 'Record demo', toColumn: 'To Do' }])).toBe(true);
    expect(parseInboxKanban(readFileSync(file, 'utf-8')).columns['To Do'].map(t => t.text)).toEqual(['Record demo']);
  });

  it('never overwrites an existing board', async () => {
    const file = path.join(vault, 'Planning', 'Board.md');
    await createBoard(fsVaultOps(vault), vault);
    writeFileSync(file, '## Mine\n\n- [ ] keep me\n');
    expect(await createBoard(fsVaultOps(vault), vault)).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe('## Mine\n\n- [ ] keep me\n');
  });

  it('runs as an agent action, together with a task in the same block, and refuses a second board', async () => {
    const { vaultActions } = parseAgentReply('Done.<actions>[{"type":"create_board"},{"type":"add_task","text":"Call Maria","column":"To Do"}]</actions>');
    const changes: string[] = [];
    const results = await executeVaultActions(vault, fsVaultOps(vault), new Store(), vaultActions, c => changes.push(`${c.kind} ${c.path}`));
    expect(results.filter(r => !r.ok)).toEqual([]);
    expect(changes).toContain('created Planning/Board.md');
    expect(readFileSync(path.join(vault, 'Planning', 'Board.md'), 'utf-8')).toContain('Call Maria');

    const again = await executeVaultActions(vault, fsVaultOps(vault), new Store(), [{ type: 'create_board' }]);
    expect(again[0]).toMatchObject({ ok: false });
  });
});
