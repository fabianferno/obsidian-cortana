// vault/ops.ts - every write to a file inside the vault goes through VaultOps.
//
// In the plugin these are Obsidian's own calls (vault.process, fileManager), so an
// open note never loses keystrokes and moved notes keep their links. The fs
// version below is for tests and for running without Obsidian.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

export interface VaultOps {
  /** Moves a note, keeping links working. */
  move(fromRel: string, toRel: string): Promise<void>;
  /** Sends a note to the trash. */
  trash(rel: string): Promise<void>;
  /**
   * Atomic read-modify-write of a vault-relative path (forward slashes). A
   * missing file is created, with any missing folders, from `edit('')`. When
   * `edit` returns the content unchanged nothing is written.
   */
  process(rel: string, edit: (content: string) => string): Promise<void>;
}

/** A vault-relative path with forward slashes, for VaultOps. */
export function vaultRel(vaultPath: string, abs: string): string {
  return path.relative(vaultPath, abs).split(path.sep).join('/');
}

/** Plain file-system ops, for tests and when no Obsidian vault is available. */
export function fsVaultOps(vaultPath: string): VaultOps {
  return {
    async move(fromRel, toRel) {
      const to = path.join(vaultPath, toRel);
      mkdirSync(path.dirname(to), { recursive: true });
      renameSync(path.join(vaultPath, fromRel), to);
    },
    async trash(rel) {
      const to = path.join(vaultPath, '.trash', path.basename(rel));
      mkdirSync(path.dirname(to), { recursive: true });
      renameSync(path.join(vaultPath, rel), to);
    },
    async process(rel, edit) {
      const file = path.join(vaultPath, rel);
      const exists = existsSync(file);
      const before = exists ? readFileSync(file, 'utf-8') : '';
      const after = edit(before);
      if (exists && after === before) return;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, after, 'utf-8');
    },
  };
}
