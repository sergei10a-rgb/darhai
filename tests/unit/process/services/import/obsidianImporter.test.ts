/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  detectVaults,
  runObsidianImport,
  readConfinedVaultFile,
  extractWikilinkNames,
  previewVault,
} from '@process/services/import/obsidianImporter';
import { parseMarkdownBlocks } from '@process/services/memory/markdownFrontmatter';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wayland-obsidian-test-'));
}

function makeVault(baseDir: string, vaultName: string, mdFiles: Record<string, string>): string {
  const vaultPath = path.join(baseDir, vaultName);
  const obsidianDir = path.join(vaultPath, '.obsidian');
  fs.mkdirSync(obsidianDir, { recursive: true });
  // Write .obsidian/config to make it a real vault.
  fs.writeFileSync(path.join(obsidianDir, 'config'), '{}', 'utf8');
  for (const [name, content] of Object.entries(mdFiles)) {
    fs.writeFileSync(path.join(vaultPath, name), content, 'utf8');
  }
  return vaultPath;
}

describe('detectVaults', () => {
  // Note: detectVaults scans ~/Documents/ - we can't easily mock os.homedir in
  // this test environment. We verify it returns an array without throwing.
  it('returns an array (empty or non-empty) without throwing', async () => {
    const result = await detectVaults();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('runObsidianImport', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  it('returns error when vault path does not exist', async () => {
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    const result = await runObsidianImport('/nonexistent/vault/path', { ijfwMemoryDir: memDir });
    expect(result.imported).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('not found');
  });

  it('imports .md files from a vault', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    const vaultPath = makeVault(baseDir, 'TestVault', {
      'Note One.md': '# My Note\nSome content here.',
      'Note Two.md': '---\ntags: [architecture, design]\n---\n# Second Note\nMore content.',
    });

    const result = await runObsidianImport(vaultPath, { ijfwMemoryDir: memDir });

    expect(result.errors).toHaveLength(0);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);

    const importedFiles = fs.readdirSync(memDir);
    expect(importedFiles.length).toBe(2);
    expect(importedFiles.every((f) => f.startsWith('obsidian-'))).toBe(true);
  });

  it('skips files already imported (deduplication by id)', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    const vaultPath = makeVault(baseDir, 'TestVault', {
      'Note.md': '# Dedup Note\nBody text.',
    });

    // First import.
    const first = await runObsidianImport(vaultPath, { ijfwMemoryDir: memDir });
    expect(first.imported).toBe(1);
    expect(first.skipped).toBe(0);

    // Second import - should skip.
    const second = await runObsidianImport(vaultPath, { ijfwMemoryDir: memDir });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('excludes .obsidian and .trash directories', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    const vaultPath = makeVault(baseDir, 'TestVault', {
      'Real.md': '# Real note',
    });
    // Manually create a .trash dir with a .md file.
    const trashDir = path.join(vaultPath, '.trash');
    fs.mkdirSync(trashDir, { recursive: true });
    fs.writeFileSync(path.join(trashDir, 'Trashed.md'), '# Trash', 'utf8');

    const result = await runObsidianImport(vaultPath, { ijfwMemoryDir: memDir });
    expect(result.imported).toBe(1); // Only Real.md.
  });

  it('does not read a vault .md that resolves (via symlink) outside the vault root (TOCTOU RT-B5-01)', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);
    const memDir = makeTmp();
    tmpDirs.push(memDir);
    const secretDir = makeTmp();
    tmpDirs.push(secretDir);

    // A sensitive file living OUTSIDE the vault.
    const secretPath = path.join(secretDir, 'id_rsa');
    const secretContent = 'SECRET-PRIVATE-KEY-DO-NOT-LEAK';
    fs.writeFileSync(secretPath, secretContent, 'utf8');

    // Build a vault with one legitimate note.
    const vaultPath = makeVault(baseDir, 'TestVault', {
      'Real.md': '# Real note\nLegit body.',
    });

    // Plant a vault .md that is actually a symlink pointing OUT of the vault to
    // the secret. This simulates the TOCTOU swap: a `.md` entry whose realpath
    // escapes the vault root.
    const evilPath = path.join(vaultPath, 'Evil.md');
    try {
      fs.symlinkSync(secretPath, evilPath);
    } catch {
      // Platform cannot create symlinks (e.g. Windows without privilege) -
      // the guard is irrelevant there; skip without failing.
      return;
    }

    const result = await runObsidianImport(vaultPath, { ijfwMemoryDir: memDir });

    // The legitimate note imports; the escaping symlink does not.
    expect(result.imported).toBe(1);

    // No imported file may contain the secret content.
    const importedFiles = fs.readdirSync(memDir);
    for (const f of importedFiles) {
      const content = fs.readFileSync(path.join(memDir, f), 'utf8');
      expect(content).not.toContain(secretContent);
    }
  });

  it('read-time guard refuses a file that was swapped to an out-of-vault symlink (the TOCTOU race)', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);
    const secretDir = makeTmp();
    tmpDirs.push(secretDir);

    const vaultPath = path.join(baseDir, 'TestVault');
    fs.mkdirSync(vaultPath, { recursive: true });

    const secretPath = path.join(secretDir, 'id_rsa');
    const secretContent = 'SECRET-PRIVATE-KEY-DO-NOT-LEAK';
    fs.writeFileSync(secretPath, secretContent, 'utf8');

    // The walker handed us this path while it was a regular .md; by read time
    // it is now a symlink pointing OUTSIDE the vault. This is the precise race
    // that readConfinedVaultFile must refuse.
    const racedPath = path.join(vaultPath, 'Note.md');
    try {
      fs.symlinkSync(secretPath, racedPath);
    } catch {
      return; // No symlink privilege on this platform - guard is moot.
    }

    const content = await readConfinedVaultFile(racedPath, path.resolve(vaultPath));
    expect(content).toBeNull();
  });

  it('read-time guard reads a normal in-vault .md normally', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);

    const vaultPath = path.join(baseDir, 'TestVault');
    fs.mkdirSync(vaultPath, { recursive: true });
    const filePath = path.join(vaultPath, 'Note.md');
    fs.writeFileSync(filePath, '# Hello\nbody', 'utf8');

    const content = await readConfinedVaultFile(filePath, path.resolve(vaultPath));
    expect(content).toBe('# Hello\nbody');
  });

  it('parses frontmatter tags from vault files', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    const vaultPath = makeVault(baseDir, 'TestVault', {
      'Tagged.md': '---\ntags: [design, patterns]\n---\n# Tagged Note\nContent.',
    });

    await runObsidianImport(vaultPath, { ijfwMemoryDir: memDir });

    const files = fs.readdirSync(memDir);
    const content = fs.readFileSync(path.join(memDir, files[0]), 'utf8');
    expect(content).toContain('design');
    expect(content).toContain('patterns');
  });

  it('a note with its own frontmatter yields EXACTLY one parsed block - no phantom entry (M3)', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    const vaultPath = makeVault(baseDir, 'TestVault', {
      'WithFm.md': '---\ntags: [design, patterns]\naliases: [x]\n---\n# Titled Note\nBody line one.\nBody line two.',
    });

    const result = await runObsidianImport(vaultPath, { ijfwMemoryDir: memDir });
    expect(result.imported).toBe(1);

    const files = fs.readdirSync(memDir);
    const content = fs.readFileSync(path.join(memDir, files[0]), 'utf8');
    const blocks = parseMarkdownBlocks(content);

    // Double frontmatter used to split this into a phantom empty-body entry
    // plus a second block whose "frontmatter" was the note's own - one real
    // entry must come out, with the generated frontmatter and the note body.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].frontmatter['source']).toBe('obsidian');
    expect(blocks[0].frontmatter['summary']).toBe('Titled Note');
    expect(blocks[0].frontmatter['tags']).toEqual(['design', 'patterns']);
    expect(blocks[0].body).toContain('# Titled Note');
    expect(blocks[0].body).toContain('Body line two.');
    // The note's own frontmatter must NOT survive as body/second frontmatter.
    expect(blocks[0].body).not.toContain('aliases');
  });

  it('a CRLF note with frontmatter also imports as one clean block (M3)', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    const vaultPath = makeVault(baseDir, 'TestVault', {
      'Crlf.md': '---\r\ntags: [win]\r\n---\r\n# CRLF Note\r\nWindows body.',
    });

    await runObsidianImport(vaultPath, { ijfwMemoryDir: memDir });
    const files = fs.readdirSync(memDir);
    const content = fs.readFileSync(path.join(memDir, files[0]), 'utf8');
    const blocks = parseMarkdownBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].frontmatter['tags']).toEqual(['win']);
    expect(blocks[0].body).toContain('Windows body.');
  });

  it('imports Cyrillic-named files (incl. nested Cyrillic dirs) and stays idempotent', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    const vaultPath = makeVault(baseDir, 'Миний сан', {
      'Монгол тэмдэглэл.md': '---\ntags: [санамж, дархай]\n---\n# Монгол гарчиг\nКирилл бие. [[Дархай]] линк.',
    });
    // Nested Cyrillic directory with a Cyrillic-named note.
    const subDir = path.join(vaultPath, 'Төсөл');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'Дархай санамж.md'), '# Дархай\nДотоод тэмдэглэл.', 'utf8');

    const first = await runObsidianImport(vaultPath, { ijfwMemoryDir: memDir });
    expect(first.errors).toHaveLength(0);
    expect(first.imported).toBe(2);

    const files = fs.readdirSync(memDir);
    expect(files.length).toBe(2);
    const contents = files.map((f) => fs.readFileSync(path.join(memDir, f), 'utf8'));
    // Cyrillic body, tags, summary and relative source path survive the import.
    expect(contents.some((c) => c.includes('Монгол гарчиг'))).toBe(true);
    expect(contents.some((c) => c.includes('санамж'))).toBe(true);
    expect(contents.some((c) => c.includes(path.join('Төсөл', 'Дархай санамж.md')))).toBe(true);
    // Wikilink target extracted from the Cyrillic body.
    expect(contents.some((c) => c.includes('links: [Дархай]'))).toBe(true);

    // Re-import is idempotent: nothing new, everything skipped.
    const second = await runObsidianImport(vaultPath, { ijfwMemoryDir: memDir });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);
    expect(fs.readdirSync(memDir).length).toBe(2);
  });

  it('writes [[wikilink]] targets into the generated frontmatter links field', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    const vaultPath = makeVault(baseDir, 'TestVault', {
      'Hub.md': '# Hub\nSee [[Alpha]] and [[Beta|the beta page]], plus [[Alpha]] again.',
    });

    await runObsidianImport(vaultPath, { ijfwMemoryDir: memDir });

    const files = fs.readdirSync(memDir);
    const content = fs.readFileSync(path.join(memDir, files[0]), 'utf8');
    // Unique targets, alias resolved to the target name, duplicates dropped.
    expect(content).toContain('links: [Alpha, Beta]');
  });

  it('omits the links field when a note has no wikilinks', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    const vaultPath = makeVault(baseDir, 'TestVault', {
      'Plain.md': '# Plain\nNo links here.',
    });

    await runObsidianImport(vaultPath, { ijfwMemoryDir: memDir });

    const files = fs.readdirSync(memDir);
    const content = fs.readFileSync(path.join(memDir, files[0]), 'utf8');
    expect(content).not.toContain('links:');
  });

  it('reports progress up to the total across imported and skipped files', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    const vaultPath = makeVault(baseDir, 'TestVault', {
      'A.md': '# A',
      'B.md': '# B',
      'C.md': '# C',
    });

    const calls: Array<[number, number]> = [];
    await runObsidianImport(vaultPath, {
      ijfwMemoryDir: memDir,
      onProgress: (done, total) => calls.push([done, total]),
    });
    // Final call always reports done === total.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]).toEqual([3, 3]);

    // A re-import (all skipped) still reaches the total.
    calls.length = 0;
    await runObsidianImport(vaultPath, {
      ijfwMemoryDir: memDir,
      onProgress: (done, total) => calls.push([done, total]),
    });
    expect(calls[calls.length - 1]).toEqual([3, 3]);
  });
});

describe('extractWikilinkNames', () => {
  it('returns unique names in order of first appearance, alias-resolved', () => {
    expect(extractWikilinkNames('See [[Alpha]], [[Beta|alias]] and [[Alpha]].')).toEqual(['Alpha', 'Beta']);
  });

  it('handles Cyrillic link names', () => {
    expect(extractWikilinkNames('Үз: [[Дархай төсөл]] ба [[Санах ой|memory]].')).toEqual(['Дархай төсөл', 'Санах ой']);
  });

  it('returns [] when there are no wikilinks', () => {
    expect(extractWikilinkNames('No links at all.')).toEqual([]);
  });
});

describe('previewVault', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  it('counts .md notes and sums their byte size without importing', async () => {
    const baseDir = makeTmp();
    tmpDirs.push(baseDir);

    const vaultPath = makeVault(baseDir, 'PreviewVault', {
      'One.md': '0123456789', // 10 bytes
      'Two.md': '01234', // 5 bytes
    });
    // .obsidian / hidden dirs must not count.
    fs.writeFileSync(path.join(vaultPath, '.obsidian', 'ignored.md'), 'x', 'utf8');

    const preview = await previewVault(vaultPath);
    expect(preview.mdCount).toBe(2);
    expect(preview.totalBytes).toBe(15);
  });

  it('previews a missing vault as zero without throwing', async () => {
    const preview = await previewVault(path.join(os.tmpdir(), 'darhai-no-such-vault-xyz'));
    expect(preview).toEqual({ mdCount: 0, totalBytes: 0 });
  });
});
