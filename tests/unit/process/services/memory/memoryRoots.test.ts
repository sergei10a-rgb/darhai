/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GLOBAL_PROJECT_NAME,
  ensureIjfwBootstrap,
  globalMemoryDir,
  listMemoryFiles,
  registerProject,
  registryPath,
  resolveMemoryRoots,
} from '@process/services/memory/memoryRoots';

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  // Repo-local rather than os.tmpdir(): registry-derived roots are deliberately
  // skipped when their path contains a temp segment.
  home = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp-roots-'));
  originalHome = process.env.DARHAI_IJFW_HOME;
  process.env.DARHAI_IJFW_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DARHAI_IJFW_HOME;
  else process.env.DARHAI_IJFW_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ensureIjfwBootstrap', () => {
  it('creates the global memory directory and a registry the user never had to write', async () => {
    expect(fs.existsSync(globalMemoryDir())).toBe(false);
    expect(fs.existsSync(registryPath())).toBe(false);

    await ensureIjfwBootstrap();

    expect(fs.existsSync(globalMemoryDir())).toBe(true);
    expect(fs.existsSync(registryPath())).toBe(true);
  });

  it('never truncates an existing registry', async () => {
    fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
    fs.writeFileSync(registryPath(), 'C:\\some\\project | abc | 2026-01-01T00:00:00.000Z\n', 'utf8');

    await ensureIjfwBootstrap();

    expect(fs.readFileSync(registryPath(), 'utf8')).toContain('C:\\some\\project');
  });
});

describe('resolveMemoryRoots', () => {
  it('always includes the home-scoped root, which is where global writes land', async () => {
    const roots = await resolveMemoryRoots();
    const global = roots.find((r) => r.isGlobal);
    expect(global).toBeDefined();
    expect(global?.projectName).toBe(GLOBAL_PROJECT_NAME);
    expect(path.resolve(global!.memoryDir)).toBe(path.resolve(globalMemoryDir()));
  });

  it('includes a registered project that has a memory directory', async () => {
    const project = path.join(home, 'proj-mn');
    fs.mkdirSync(path.join(project, '.ijfw', 'memory'), { recursive: true });

    expect(await registerProject(project)).toBe(true);
    // Idempotent: a second call must not duplicate the line.
    expect(await registerProject(project)).toBe(false);

    const roots = await resolveMemoryRoots();
    expect(roots.map((r) => r.projectName)).toContain('proj-mn');
    expect(roots.filter((r) => r.projectName === 'proj-mn')).toHaveLength(1);
  });

  it('refuses to register a directory with no memory dir', async () => {
    const notAProject = path.join(home, 'plain-dir');
    fs.mkdirSync(notAProject, { recursive: true });
    expect(await registerProject(notAProject)).toBe(false);
  });
});

describe('listMemoryFiles', () => {
  it('lists importer-written filenames, not just the six well-known names', async () => {
    await ensureIjfwBootstrap();
    const dir = globalMemoryDir();
    for (const name of [
      'journal.md',
      'dropped-1785512671892-sanamj.md',
      'obsidian-abc123.md',
      'devscan-def456.md',
      'observation-999.md',
      'notes.txt',
      '.hidden.md',
    ]) {
      fs.writeFileSync(path.join(dir, name), '---\nsummary: x\n---\nbody\n', 'utf8');
    }

    const files = await listMemoryFiles(dir);
    expect(files).toContain('journal.md');
    expect(files).toContain('dropped-1785512671892-sanamj.md');
    expect(files).toContain('obsidian-abc123.md');
    expect(files).toContain('devscan-def456.md');
    expect(files).toContain('observation-999.md');
    expect(files).not.toContain('notes.txt');
    expect(files).not.toContain('.hidden.md');
  });

  it('returns nothing for a missing directory', async () => {
    expect(await listMemoryFiles(path.join(home, 'nope'))).toEqual([]);
  });
});
