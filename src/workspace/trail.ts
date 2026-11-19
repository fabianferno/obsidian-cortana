// workspace/trail.ts - what the user has open in Obsidian, as quiet background for a reply.
//
// The plugin tells the trail which file is in front; the trail keeps how long each
// was open. Daily notes and the board are left out of every snapshot: the agent never
// sees the daily folder, and the board is already in the [Context] block.

export type FileKind = 'note' | 'board' | 'canvas' | 'pdf' | 'other';

export interface OpenFile {
  /** Vault-relative path, with extension. */
  path: string;
  kind: FileKind;
  openForMin: number;
  /** The heading the cursor is under. */
  heading?: string;
  /** Text the user has selected, capped. */
  selection?: string;
}

export interface WorkspaceSnapshot {
  active?: OpenFile;
  /** Files open earlier (at least a minute, in the last half hour), newest first. */
  recent: { path: string; minutes: number }[];
  /** False when another app is in front (the "talk from anywhere" shortcut). */
  obsidianFocused: boolean;
  /** Notes typed in during the last 20 minutes: distinct minutes with typing, most first. */
  typing?: { path: string; minutes: number }[];
}

export const SELECTION_MAX = 1500;
const RECENT_WINDOW_MS = 30 * 60 * 1000;
const RECENT_MIN_MS = 60 * 1000;
const RECENT_MAX = 3;
export const TYPING_WINDOW_MS = 20 * 60 * 1000;

export class WorkspaceTrail {
  private current?: { path: string; kind: FileKind; since: number };
  private dwell = new Map<string, { ms: number; lastSeen: number }>();
  /** Minute numbers (since the epoch) in which each note was typed in. */
  private typedAt = new Map<string, Set<number>>();

  /** The file now in front, or null for a tab without one. */
  open(path: string | null, kind: FileKind = 'note', now = Date.now()): void {
    if (path && this.current?.path === path) return;
    if (this.current) {
      const prev = this.dwell.get(this.current.path);
      this.dwell.set(this.current.path, { ms: (prev?.ms ?? 0) + now - this.current.since, lastSeen: now });
    }
    for (const [p, d] of this.dwell) if (now - d.lastSeen > RECENT_WINDOW_MS) this.dwell.delete(p);
    this.current = path ? { path, kind, since: now } : undefined;
  }

  /** The user typed in a note. */
  typed(path: string, now = Date.now()): void {
    const oldest = Math.floor((now - TYPING_WINDOW_MS) / 60000);
    for (const [p, minutes] of this.typedAt) {
      for (const m of minutes) if (m < oldest) minutes.delete(m);
      if (!minutes.size) this.typedAt.delete(p);
    }
    const minutes = this.typedAt.get(path) ?? new Set<number>();
    minutes.add(Math.floor(now / 60000));
    this.typedAt.set(path, minutes);
  }

  get activePath(): string | undefined {
    return this.current?.path;
  }

  snapshot(now = Date.now(), live: { heading?: string; selection?: string; obsidianFocused?: boolean } = {}): WorkspaceSnapshot {
    const recent = [...this.dwell.entries()]
      .filter(([p, d]) => p !== this.current?.path && d.ms >= RECENT_MIN_MS && now - d.lastSeen <= RECENT_WINDOW_MS)
      .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
      .slice(0, RECENT_MAX)
      .map(([path, d]) => ({ path, minutes: Math.round(d.ms / 60000) }));
    const selection = live.selection?.trim();
    const active: OpenFile | undefined = this.current && {
      path: this.current.path,
      kind: this.current.kind,
      openForMin: Math.floor((now - this.current.since) / 60000),
      ...(live.heading ? { heading: live.heading } : {}),
      ...(selection ? { selection: selection.length > SELECTION_MAX ? `${selection.slice(0, SELECTION_MAX)}...` : selection } : {}),
    };
    const oldest = Math.floor((now - TYPING_WINDOW_MS) / 60000);
    const typing = [...this.typedAt.entries()]
      .map(([path, minutes]) => ({ path, minutes: [...minutes].filter(m => m >= oldest).length }))
      .filter(t => t.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes);
    return { ...(active ? { active } : {}), recent, obsidianFocused: live.obsidianFocused ?? true, ...(typing.length ? { typing } : {}) };
  }
}

/** True for files the agent must not be shown: the daily folder and the board. */
export function hiddenFromAgent(path: string, layout: { dailyFolder: string; boardPath: string }): boolean {
  const daily = layout.dailyFolder.replace(/^\/+|\/+$/g, '');
  if (daily && (path === daily || path.startsWith(`${daily}/`))) return true;
  return path === layout.boardPath;
}

/** The snapshot without anything the agent must not see. Null when nothing is left. */
export function visibleSnapshot(snap: WorkspaceSnapshot, layout: { dailyFolder: string; boardPath: string }): WorkspaceSnapshot | null {
  const active = snap.active && !hiddenFromAgent(snap.active.path, layout) ? snap.active : undefined;
  const recent = snap.recent.filter(r => !hiddenFromAgent(r.path, layout));
  const typing = snap.typing?.filter(t => !hiddenFromAgent(t.path, layout)) ?? [];
  if (!active && !recent.length && !typing.length) return null;
  return { ...(active ? { active } : {}), recent, obsidianFocused: snap.obsidianFocused, ...(typing.length ? { typing } : {}) };
}
