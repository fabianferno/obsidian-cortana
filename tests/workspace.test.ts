import { describe, expect, it } from 'vitest';
import { SELECTION_MAX, WorkspaceTrail, hiddenFromAgent, visibleSnapshot } from '../src/workspace/trail.js';

const MIN = 60_000;
const layout = { dailyFolder: 'Daily', boardPath: 'Boards/Inbox.md' };

describe('WorkspaceTrail', () => {
  it('reports the open file and how long it has been open', () => {
    const t = new WorkspaceTrail();
    t.open('Projects/Acme.md', 'note', 0);
    expect(t.snapshot(12 * MIN).active).toEqual({ path: 'Projects/Acme.md', kind: 'note', openForMin: 12 });
  });

  it('reopening the same file keeps its start time', () => {
    const t = new WorkspaceTrail();
    t.open('A.md', 'note', 0);
    t.open('A.md', 'note', 5 * MIN);
    expect(t.snapshot(6 * MIN).active?.openForMin).toBe(6);
  });

  it('lists files open earlier for a minute or more, newest first, not the current one', () => {
    const t = new WorkspaceTrail();
    t.open('A.md', 'note', 0);
    t.open('Blip.md', 'note', 5 * MIN);       // A: 5 min
    t.open('B.md', 'note', 5 * MIN + 10_000); // Blip: 10 s, too short
    t.open('C.md', 'note', 8 * MIN);          // B: ~3 min
    expect(t.snapshot(9 * MIN).recent).toEqual([{ path: 'B.md', minutes: 3 }, { path: 'A.md', minutes: 5 }]);
  });

  it('forgets files after half an hour', () => {
    const t = new WorkspaceTrail();
    t.open('A.md', 'note', 0);
    t.open('B.md', 'note', 5 * MIN);
    expect(t.snapshot(40 * MIN).recent).toEqual([]);
  });

  it('a tab without a file clears the active file', () => {
    const t = new WorkspaceTrail();
    t.open('A.md', 'note', 0);
    t.open(null, 'note', 2 * MIN);
    const snap = t.snapshot(3 * MIN);
    expect(snap.active).toBeUndefined();
    expect(snap.recent).toEqual([{ path: 'A.md', minutes: 2 }]);
  });

  it('adds heading and selection, capping a long selection and dropping a blank one', () => {
    const t = new WorkspaceTrail();
    t.open('A.md', 'note', 0);
    const long = t.snapshot(0, { heading: 'Pricing', selection: 'x'.repeat(SELECTION_MAX + 50) }).active;
    expect(long?.heading).toBe('Pricing');
    expect(long?.selection).toHaveLength(SELECTION_MAX + 3);
    expect(t.snapshot(0, { selection: '   ' }).active?.selection).toBeUndefined();
  });
});

describe('WorkspaceTrail typing', () => {
  it('counts distinct minutes typed per note in the last 20 minutes', () => {
    const t = new WorkspaceTrail();
    t.typed('A.md', 0);
    t.typed('A.md', 10_000);      // same minute
    t.typed('A.md', 2 * MIN);
    expect(t.snapshot(21 * MIN).typing).toEqual([{ path: 'A.md', minutes: 1 }]);
    t.typed('B.md', 25 * MIN);
    expect(t.snapshot(26 * MIN).typing).toEqual([{ path: 'B.md', minutes: 1 }]);
  });

  it('drops typing in daily notes from the snapshot', () => {
    const snap = visibleSnapshot({ recent: [], obsidianFocused: true, typing: [{ path: 'Daily/x.md', minutes: 9 }, { path: 'A.md', minutes: 2 }] }, layout);
    expect(snap?.typing).toEqual([{ path: 'A.md', minutes: 2 }]);
  });
});

describe('visibleSnapshot', () => {
  it('never shows daily notes or the board', () => {
    expect(hiddenFromAgent('Daily/2026-11-19.md', layout)).toBe(true);
    expect(hiddenFromAgent('Boards/Inbox.md', layout)).toBe(true);
    expect(hiddenFromAgent('Dailyish.md', layout)).toBe(false);
    const snap = visibleSnapshot({
      active: { path: 'Daily/2026-11-19.md', kind: 'note', openForMin: 3, selection: 'private' },
      recent: [{ path: 'Boards/Inbox.md', minutes: 4 }, { path: 'People/Ravi.md', minutes: 2 }],
      obsidianFocused: true,
    }, layout);
    expect(snap).toEqual({ recent: [{ path: 'People/Ravi.md', minutes: 2 }], obsidianFocused: true });
  });

  it('is null when nothing visible is left', () => {
    expect(visibleSnapshot({ active: { path: 'Boards/Inbox.md', kind: 'board', openForMin: 1 }, recent: [], obsidianFocused: true }, layout)).toBeNull();
  });
});
