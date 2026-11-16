// journal/people.ts - a person mentioned in conversation (the older people_note action).

import { captureToNote, type CaptureResult } from './capture.js';
import type { VaultOps } from '../vault/ops.js';

export function handlePersonMention(ops: VaultOps, name: string, note: string, vaultPath: string): Promise<CaptureResult> {
  return captureToNote(ops, vaultPath, { title: name, noteType: 'people', text: note });
}
