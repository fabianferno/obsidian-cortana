// journal/literature.ts - a book, article or podcast mentioned in conversation
// (the older literature_note action).

import { captureToNote, type CaptureResult } from './capture.js';
import type { VaultOps } from '../vault/ops.js';

export function handleLiteratureMention(
  ops: VaultOps,
  title: string,
  noteType: string,
  source: string,
  note: string,
  vaultPath: string,
): Promise<CaptureResult> {
  const from = [noteType, source].filter(Boolean).join(', ');
  return captureToNote(ops, vaultPath, { title, noteType: 'literature', text: from ? `${note} (${from})` : note });
}
