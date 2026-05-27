/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectVaults, runObsidianImport } from '@process/services/import/obsidianImporter';

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
  // Note: detectVaults scans ~/Documents/ — we can't easily mock os.homedir in
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

    // Second import — should skip.
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
});
