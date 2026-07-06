/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runClaudeNativeImport } from '@process/services/import/claudeNativeImporter';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-claude-native-test-'));
}

/** Build a fake ~/.claude/projects root with one project holding memory files. */
function makeProjectsRoot(base: string, project: string, files: Record<string, string>): void {
  const memDir = path.join(base, project, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(memDir, name), content, 'utf8');
  }
}

const SAMPLE_MEMORY = [
  '---',
  'name: prefers-strict-ts',
  'description: Always use strict TypeScript',
  'metadata:',
  '  type: feedback',
  '---',
  'Strict mode everywhere.',
].join('\n');

describe('runClaudeNativeImport', () => {
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

  it('imports memory files from Claude Code projects', async () => {
    const projectsRoot = makeTmp();
    tmpDirs.push(projectsRoot);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    makeProjectsRoot(projectsRoot, 'C--claude', {
      'prefers-strict-ts.md': SAMPLE_MEMORY,
      'another.md': '---\nname: two\ndescription: Second fact\n---\nBody two.',
    });

    const result = await runClaudeNativeImport({ ijfwMemoryDir: memDir, projectsRoot });

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);

    const files = fs.readdirSync(memDir);
    expect(files.length).toBe(2);
    expect(files.every((f) => f.startsWith('claude-'))).toBe(true);

    // Description becomes the summary in the written frontmatter.
    const merged = files.map((f) => fs.readFileSync(path.join(memDir, f), 'utf8')).join('\n');
    expect(merged).toContain('Always use strict TypeScript');
    expect(merged).toContain('source: claude-code');
  });

  it('skips the MEMORY.md index file', async () => {
    const projectsRoot = makeTmp();
    tmpDirs.push(projectsRoot);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    makeProjectsRoot(projectsRoot, 'proj', {
      'MEMORY.md': '# Index\n- [a](a.md)',
      'fact.md': SAMPLE_MEMORY,
    });

    const result = await runClaudeNativeImport({ ijfwMemoryDir: memDir, projectsRoot });
    expect(result.imported).toBe(1); // only fact.md
  });

  it('deduplicates on a second run', async () => {
    const projectsRoot = makeTmp();
    tmpDirs.push(projectsRoot);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    makeProjectsRoot(projectsRoot, 'proj', { 'fact.md': SAMPLE_MEMORY });

    const first = await runClaudeNativeImport({ ijfwMemoryDir: memDir, projectsRoot });
    expect(first.imported).toBe(1);

    const second = await runClaudeNativeImport({ ijfwMemoryDir: memDir, projectsRoot });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('returns a not-found note when the projects root is empty', async () => {
    const projectsRoot = makeTmp(); // exists but has no project/memory dirs
    tmpDirs.push(projectsRoot);
    const memDir = makeTmp();
    tmpDirs.push(memDir);

    const result = await runClaudeNativeImport({ ijfwMemoryDir: memDir, projectsRoot });
    expect(result.imported).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('No Claude Code memory');
  });
});
