// journal/capture.ts - files something from a conversation into the vault.
//
// An existing note (found by name or alias anywhere the agent may look) gets a
// dated line in its Timeline; the user's own text is never touched. A new
// subject gets a new note in the capture folder, where the daily graduation pass
// picks it up later.

import path from 'path';
import { captureDir, notesDir } from '../config/paths.js';
import { localDate } from '../checkins/scheduler.js';
import { appendTimeline, findNote, timelineLine } from '../vault/notes.js';
import { vaultRel, type VaultOps } from '../vault/ops.js';

export interface CaptureInput {
  /** The note's name: a person, project, idea... */
  title: string;
  /** The vault's type tag for a new note (people, projects, concept...). */
  noteType?: string;
  /** What to record, in the user's words. */
  text: string;
  /** Where it came from. Defaults to the conversation. */
  source?: string;
  date?: string;
}

export interface CaptureResult {
  action: 'appended' | 'created';
  filePath: string;
}

/** A title made safe as a file name. */
export function noteFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Untitled';
}

export async function captureToNote(ops: VaultOps, vaultPath: string, input: CaptureInput): Promise<CaptureResult> {
  const date = input.date ?? localDate(new Date());
  const line = timelineLine(date, input.text, input.source ?? 'voice chat');
  const title = noteFileName(input.title);

  const existing = findNote(vaultPath, input.title) ?? findNote(vaultPath, title);
  if (existing) {
    await ops.process(vaultRel(vaultPath, existing), content => appendTimeline(content, line));
    return { action: 'appended', filePath: existing };
  }

  const dir = captureDir(vaultPath) ?? notesDir(vaultPath);
  const filePath = path.join(dir, `${title}.md`);
  const type = input.noteType && /^[a-z][a-z0-9/-]*$/.test(input.noteType) ? input.noteType : '';
  const frontmatter = type ? `---\ntags:\n  - ${type}\n---\n` : '';
  let action: CaptureResult['action'] = 'created';
  await ops.process(vaultRel(vaultPath, filePath), content => {
    // A file findNote skipped (say, in a hidden folder) is appended to, never overwritten.
    if (content) {
      action = 'appended';
      return appendTimeline(content, line);
    }
    return `${frontmatter}# ${title}\n\n## Timeline\n${line}\n\n##### References\n`;
  });
  return { action, filePath };
}
