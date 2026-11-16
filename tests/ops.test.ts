import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fsVaultOps, vaultRel } from '../src/vault/ops.js';

let vault = '';

afterEach(() => {
  if (vault) rmSync(vault, { recursive: true, force: true });
});

describe('fsVaultOps.process', () => {
  it('creates a missing file and its folders from edit("")', async () => {
    vault = mkdtempSync(path.join(tmpdir(), 'vault-ops-'));
    let seen: string | null = null;
    await fsVaultOps(vault).process('a/b/New.md', c => { seen = c; return 'hello\n'; });
    expect(seen).toBe('');
    expect(readFileSync(path.join(vault, 'a', 'b', 'New.md'), 'utf-8')).toBe('hello\n');
  });

  it('edits in place and does not rewrite when the content is unchanged', async () => {
    vault = mkdtempSync(path.join(tmpdir(), 'vault-ops-'));
    const file = path.join(vault, 'Note.md');
    writeFileSync(file, 'one\n', 'utf-8');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(file, old, old);

    const ops = fsVaultOps(vault);
    await ops.process('Note.md', c => c);
    expect(statSync(file).mtimeMs).toBe(old.getTime());

    await ops.process('Note.md', c => `${c}two\n`);
    expect(readFileSync(file, 'utf-8')).toBe('one\ntwo\n');
    expect(statSync(file).mtimeMs).not.toBe(old.getTime());
  });

  it('vaultRel gives a forward-slash path relative to the vault', () => {
    expect(vaultRel('/v', path.join('/v', 'Notes', 'A.md'))).toBe('Notes/A.md');
  });
});
