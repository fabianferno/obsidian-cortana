import { describe, expect, it } from 'vitest';
import { detectDrift, isOnTask, noteMatchesCard } from '../src/focus/drift.js';
import type { FocusSession } from '../src/config/types.js';
import type { WorkspaceSnapshot } from '../src/workspace/trail.js';

const MIN = 60_000;
const NOW = Date.parse('2026-11-19T12:00:00Z');

const session = (over: Partial<FocusSession> = {}): FocusSession => ({
  id: 1, taskText: 'Write Acme pitch deck', rawTaskLine: '- [ ] Write Acme pitch deck ^abc123',
  estimatedMinutes: 60, estimateSource: 'user', startedAt: new Date(NOW - 25 * MIN).toISOString(),
  deadlineAt: new Date(NOW + 35 * MIN).toISOString(), escalationLevel: 0, status: 'active', ...over,
});

const snap = (over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({ recent: [], obsidianFocused: true, ...over });

describe('noteMatchesCard', () => {
  it('matches a linked note, or a note whose name words are all in the card', () => {
    expect(noteMatchesCard('Projects/Acme deck.md', session())).toBe(true);
    expect(noteMatchesCard('Notes/Pricing.md', session({ rawTaskLine: '- [ ] Write [[Pricing|price page]] ^x' }))).toBe(true);
    expect(noteMatchesCard('Notes/Pricing.md', session())).toBe(false);
    expect(noteMatchesCard('Notes/Acme hiring.md', session())).toBe(false);
  });
});

describe('isOnTask', () => {
  it('is true when the card\'s note is open or being typed in', () => {
    expect(isOnTask(session(), snap({ active: { path: 'Acme pitch.md', kind: 'note', openForMin: 3 } }))).toBe(true);
    expect(isOnTask(session(), snap({ typing: [{ path: 'Acme pitch.md', minutes: 4 }] }))).toBe(true);
    expect(isOnTask(session(), snap({ active: { path: 'Recipes.md', kind: 'note', openForMin: 3 } }))).toBe(false);
  });
});

describe('detectDrift', () => {
  const elsewhere = snap({ typing: [{ path: 'Ideas/Podcast.md', minutes: 8 }, { path: 'Recipes.md', minutes: 3 }] });

  it('fires after enough typing in unrelated notes', () => {
    const d = detectDrift([session()], elsewhere, NOW);
    expect(d?.session.id).toBe(1);
    expect(d?.minutes).toBe(11);
  });

  it('stays quiet with too little typing, a young timer, or any typing in the card\'s note', () => {
    expect(detectDrift([session()], snap({ typing: [{ path: 'Recipes.md', minutes: 5 }] }), NOW)).toBeNull();
    expect(detectDrift([session({ startedAt: new Date(NOW - 5 * MIN).toISOString() })], elsewhere, NOW)).toBeNull();
    expect(detectDrift([session()], snap({ typing: [...elsewhere.typing!, { path: 'Acme pitch.md', minutes: 1 }] }), NOW)).toBeNull();
  });

  it('a note open but not typed in is never drift', () => {
    expect(detectDrift([session()], snap({ active: { path: 'Recipes.md', kind: 'note', openForMin: 40 } }), NOW)).toBeNull();
  });

  it('skips sessions already checked, but still counts their notes as on task', () => {
    const other = session({ id: 2, taskText: 'Plan podcast episode', rawTaskLine: '- [ ] Plan [[Podcast]] episode ^p' });
    expect(detectDrift([session()], elsewhere, NOW, [1])).toBeNull();
    expect(detectDrift([session(), other], elsewhere, NOW)).toBeNull();
  });
});
