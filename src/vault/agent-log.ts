// vault/agent-log.ts - `<agentFolder>/log.md`: one greppable line per thing done in
// the vault without the user in the loop (the daily note pass, other AIs).

import path from 'path';
import { getLayout } from '../config/paths.js';
import type { VaultOps } from './ops.js';

/** Appends `## [2026-11-14] graduate | Maria B`. Never throws: the log must not break the action. */
export async function appendAgentLog(ops: VaultOps, date: string, kind: string, text: string): Promise<boolean> {
  try {
    const entry = `## [${date}] ${kind} | ${text.replace(/\s+/g, ' ')}\n`;
    await ops.process(path.posix.join(getLayout().agentFolder, 'log.md'), content =>
      (content || '# Agent log\n\nWhat the agent did in the vault, newest last.\n\n') + entry);
    return true;
  } catch {
    return false;
  }
}
