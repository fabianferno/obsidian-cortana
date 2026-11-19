import { describe, expect, it } from 'vitest';
import { buildTurn } from '../src/brain/prompt-builder.js';
import type { AgentConfig, ContextData, VaultStateContext } from '../src/config/types.js';

const vault: VaultStateContext = {
  backlogCount: 0, todoCount: 0, todoTasks: [], doingCount: 0, doingTasks: [],
  doneToday: [], overdueTasks: [], dueSoon: [], stuckTasks: [],
  currentStreak: { workout: 0 }, wipWarning: false, peopleNotes: [],
};

const location = { city: 'Chennai', country: 'IN', timezone: 'Asia/Kolkata', coordinates: { lat: 0, lng: 0 }, isTravelling: false };

const context = (v: VaultStateContext): ContextData => ({
  datetime: { now: '10:00', dayOfWeek: 'Saturday', timeOfDay: 'morning', isWeekend: true, daysUntilWeekend: 0 },
  calendar: null, health: null, location, vault: v,
});

const config = { soul: '', identity: '', user: '', goals: '', memory: [] } as unknown as AgentConfig;

describe('buildTurn board section', () => {
  it('lists columns when the board exists', () => {
    const text = buildTurn('reply', config, context(vault), []);
    expect(text).toContain('- To Do: 0 (empty)');
    expect(text).not.toContain('NOT FOUND');
  });

  it('says the board is missing instead of empty when the file does not exist', () => {
    const text = buildTurn('reply', config, context({ ...vault, boardMissing: 'Kanban.md' }), []);
    expect(text).toContain('no board file at "Kanban.md"');
    expect(text).not.toContain('- To Do: 0 (empty)');
  });
});

describe('buildTurn location', () => {
  it('adds coordinates when user.md has them, and leaves them out when it does not', () => {
    const withCoords = { ...context(vault), location: { ...location, coordinates: { lat: 13.08, lng: 80.27 } } };
    expect(buildTurn('reply', config, withCoords, [])).toContain('- Location: Chennai (13.08, 80.27)');
    expect(buildTurn('reply', config, context(vault), [])).toMatch(/- Location: Chennai\n/);
  });
});

describe('buildTurn second brain report', () => {
  it('tells the engine what the note pass did', () => {
    const text = buildTurn('morning_checkpoint', config, context(vault), [], {
      secondBrain: { moved: ['Maria B', 'Electra'], asked: 2, trashed: [], waiting: 110 },
    });
    expect(text).toContain('# Second brain');
    expect(text).toContain('- Moved to notes: Maria B, Electra');
    expect(text).toContain('- New questions left inside notes: 2');
    expect(text).toContain("- Notes waiting on the user's answer: 110");
  });
});

describe('buildTurn on screen section', () => {
  const workspace = {
    active: { path: 'Projects/Acme pitch.md', kind: 'note' as const, openForMin: 12, heading: 'Pricing', selection: 'Tiered at $9' },
    recent: [{ path: 'People/Ravi.md', minutes: 5 }],
    obsidianFocused: true,
  };

  it('shows the open note, selection and earlier notes on a reply', () => {
    const text = buildTurn('reply', config, context(vault), [], { userText: 'summarize this', workspace });
    expect(text).toContain('# On screen');
    expect(text).toContain('- Open: "Projects/Acme pitch.md" (12min, under "Pricing")');
    expect(text).toContain('"""\nTiered at $9\n"""');
    expect(text).toContain('- Earlier: "People/Ravi.md" (5min)');
    expect(text).not.toContain('in the background');
  });

  it('says when Obsidian is not in front', () => {
    const text = buildTurn('reply', config, context(vault), [], { workspace: { ...workspace, obsidianFocused: false } });
    expect(text).toContain('Obsidian is in the background');
  });

  it('leaves it out of check-ins and when there is nothing', () => {
    expect(buildTurn('pulse', config, context(vault), [], { workspace })).not.toContain('# On screen');
    expect(buildTurn('reply', config, context(vault), [], { workspace: null })).not.toContain('# On screen');
  });
});
