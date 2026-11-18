import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkBoardRepair, repairBoard, undoBoardRepair } from '../src/vault/repair.js';
import { fsVaultOps } from '../src/vault/ops.js';
import { setLayout } from '../src/config/paths.js';

const SETTINGS = ['%% kanban:settings', '```', '{"kanban-plugin":"board","show-checkboxes":true}', '```', '%%'];

// The damage seen in a real board: line-number prefixes from an agent's read
// tool, ids shifted onto the wrong card, a doubled checkbox, a doubled id and a
// second settings block.
const BROKEN = [
  '---', '', 'kanban-plugin: board', '', '---', '',
  '## Backlog', '',
  '- [ ] Make synth video ^70cac2',
  '- [ ] - [ ] Learn color grading',
  '\t30|', '',
  '## Done', '',
  '- [ ] Send grant quote to silas ^0efaba',
  '\t50|- [ ] Index the zoom calls',
  '- [ ] Ask about visa ^ns-visa-status ^b89e8c',
  '', '\t70|%% kanban:settings', '', ...SETTINGS,
].join('\n');

const FIXED = [
  '---', '', 'kanban-plugin: board', '', '---', '',
  '## Backlog', '',
  '- [ ] Make synth video ^70cac2',
  '- [ ] Learn color grading',
  '', '',
  '## Done', '',
  '- [ ] Send grant quote to silas ^0efaba',
  '- [ ] Index the zoom calls',
  '- [ ] Ask about visa ^ns-visa-status',
  '', '', ...SETTINGS,
].join('\n');

function makeVault(body: string): string {
  const dir = join(tmpdir(), `repair-vault-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Kanban.md'), body, 'utf-8');
  setLayout({});
  return dir;
}

describe('checkBoardRepair', () => {
  it('accepts a repair that fixes the damage and keeps every card', () => {
    expect(checkBoardRepair(BROKEN, FIXED)).toEqual([]);
  });

  it('accepts a card text that grew, and lets a doubled id drop its spare', () => {
    expect(checkBoardRepair(BROKEN, FIXED.replace('Learn color grading', 'Learn color grading for iphone videos'))).toEqual([]);
  });

  it('refuses to lose a card, an id, a column or the settings', () => {
    expect(checkBoardRepair(BROKEN, FIXED.replace('- [ ] Index the zoom calls\n', ''))[0]).toMatch(/Index the zoom calls/);
    expect(checkBoardRepair(BROKEN, FIXED.replace(' ^0efaba', ''))[0]).toMatch(/Send grant quote/);
    expect(checkBoardRepair(BROKEN, FIXED.replace('- [ ] Ask about visa ^ns-visa-status\n', ''))[0]).toMatch(/Ask about visa/);
    expect(checkBoardRepair(BROKEN, FIXED.replace('## Done', '## Finished'))[0]).toMatch(/"Done" column/);
    expect(checkBoardRepair(BROKEN, FIXED.replace(SETTINGS.join('\n'), ''))[0]).toMatch(/settings/);
    expect(checkBoardRepair(BROKEN, FIXED.replace('kanban-plugin: board', ''))[0]).toMatch(/frontmatter/);
  });

  it('refuses a repair that leaves damage in', () => {
    expect(checkBoardRepair(BROKEN, FIXED.replace('- [ ] Index', '\t50|- [ ] Index'))).toContainEqual(expect.stringMatching(/line-number/));
    expect(checkBoardRepair(BROKEN, FIXED.replace('- [ ] Learn', '- [ ] - [ ] Learn'))).toContainEqual(expect.stringMatching(/doubled checkbox/));
    expect(checkBoardRepair(BROKEN, FIXED.replace('^ns-visa-status', '^ns-visa-status ^b89e8c'))).toContainEqual(expect.stringMatching(/two ids/));
    expect(checkBoardRepair(BROKEN, FIXED.replace('- [ ] Index the zoom calls', '- [ ] Index the zoom calls ^70cac2'))).toContainEqual(expect.stringMatching(/\^70cac2.*more than one/));
    expect(checkBoardRepair(BROKEN, `${FIXED}\n${SETTINGS.join('\n')}`)).toContainEqual(expect.stringMatching(/settings block/));
  });
});

describe('repairBoard / undoBoardRepair', () => {
  it('writes a valid repair, mints ids for new cards, and undo restores the old board', async () => {
    const vault = makeVault(BROKEN);
    const ops = fsVaultOps(vault);
    const res = await repairBoard(ops, vault, FIXED);
    expect(res.ok).toBe(true);
    const now = readFileSync(join(vault, 'Kanban.md'), 'utf-8');
    expect(now).toMatch(/- \[ \] Learn color grading \^[a-f0-9]{6}\n/);
    expect(now).toMatch(/- \[ \] Index the zoom calls \^[a-f0-9]{6}\n/);
    if (!res.ok) return;
    expect(res.backup).toEqual({ before: BROKEN, after: now });

    expect(await undoBoardRepair(ops, vault, res.backup)).toBe(true);
    expect(readFileSync(join(vault, 'Kanban.md'), 'utf-8')).toBe(BROKEN);
  });

  it('writes nothing when the repair fails a check', async () => {
    const vault = makeVault(BROKEN);
    const res = await repairBoard(fsVaultOps(vault), vault, FIXED.replace('- [ ] Index the zoom calls\n', ''));
    expect(res.ok).toBe(false);
    expect(readFileSync(join(vault, 'Kanban.md'), 'utf-8')).toBe(BROKEN);
  });

  it('undo refuses once the board has changed since the repair', async () => {
    const vault = makeVault(BROKEN);
    const ops = fsVaultOps(vault);
    const res = await repairBoard(ops, vault, FIXED);
    if (!res.ok) throw new Error('repair failed');
    writeFileSync(join(vault, 'Kanban.md'), `${res.backup.after}\n- [ ] New card`, 'utf-8');
    expect(await undoBoardRepair(ops, vault, res.backup)).toBe(false);
    expect(readFileSync(join(vault, 'Kanban.md'), 'utf-8')).toContain('New card');
  });
});
