// focus/drift.ts - is the user working on their timed card, or drifting from it?
//
// Evidence comes from the workspace trail: the note in front and the notes typed in.
// Only typing counts as drift; a note merely left open says nothing, since the user
// may be working in another app.

import type { FocusSession } from '../config/types.js';
import type { WorkspaceSnapshot } from '../workspace/trail.js';

/** A timer must run this long before drift is considered. */
export const DRIFT_SESSION_MS = 10 * 60 * 1000;
/** Minutes of typing in unrelated notes (within the trail's 20 minute window) that count as drift. */
export const DRIFT_TYPING_MIN = 10;

export interface Drift {
  session: FocusSession;
  notes: { path: string; minutes: number }[];
  minutes: number;
}

const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
const baseName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '');

/** True when the card links to the note, or every word of the note's name is in the card. */
export function noteMatchesCard(path: string, card: { taskText: string; rawTaskLine?: string }): boolean {
  const name = baseName(path).toLowerCase();
  const raw = card.rawTaskLine || card.taskText;
  for (const m of raw.matchAll(/\[\[([^\]|#]+)/g)) {
    if (baseName(m[1].trim()).toLowerCase() === name) return true;
  }
  const noteWords = words(name);
  if (!noteWords.length) return false;
  const cardWords = new Set(words(card.taskText));
  return noteWords.every(w => cardWords.has(w));
}

/** The user is in the card's note, or has been typing in it. */
export function isOnTask(session: FocusSession, snap: WorkspaceSnapshot): boolean {
  if (snap.active && noteMatchesCard(snap.active.path, session)) return true;
  return (snap.typing ?? []).some(t => t.minutes >= 2 && noteMatchesCard(t.path, session));
}

/**
 * Drift: a timer has run a while, the user typed for DRIFT_TYPING_MIN minutes in notes
 * that match none of the running cards, and not at all in any that do. Sessions in
 * `alreadyChecked` are never picked again.
 */
export function detectDrift(sessions: FocusSession[], snap: WorkspaceSnapshot, now = Date.now(), alreadyChecked: number[] = []): Drift | null {
  const session = sessions
    .filter(s => s.status === 'active' && !alreadyChecked.includes(s.id) && now - new Date(s.startedAt).getTime() >= DRIFT_SESSION_MS)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
  if (!session) return null;
  const typing = snap.typing ?? [];
  if (typing.some(t => sessions.some(s => noteMatchesCard(t.path, s)))) return null;
  const minutes = typing.reduce((sum, t) => sum + t.minutes, 0);
  return minutes >= DRIFT_TYPING_MIN ? { session, notes: typing, minutes } : null;
}
