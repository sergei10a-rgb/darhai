/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseEntriesFromFile } from '@process/services/memory/ijfwArchiveService';

// Verifies the DoS-hardening clamps in parseEntriesFromFile: attacker-controlled
// frontmatter (summary / tags) must be bounded before it can flow into the
// in-memory index or the embedder.

const MAX_SUMMARY_CHARS = 500;
const MAX_TAGS = 64;
const MAX_TAG_CHARS = 128;

describe('parseEntriesFromFile frontmatter clamping', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ijfw-clamp-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function write(md: string): string {
    const file = path.join(dir, 'knowledge.md');
    fs.writeFileSync(file, md, 'utf8');
    return file;
  }

  it('clamps an oversized summary to MAX_SUMMARY_CHARS', () => {
    const huge = 'S'.repeat(MAX_SUMMARY_CHARS * 4);
    const file = write(`---\nsummary: ${huge}\nstored: 2026-01-01\n---\nbody text\n`);
    const entries = parseEntriesFromFile(file, dir, 'proj');
    expect(entries).toHaveLength(1);
    expect(entries[0].summary.length).toBe(MAX_SUMMARY_CHARS);
  });

  it('caps the number of tags and each tag length', () => {
    // The frontmatter parser accepts inline `[a, b, c]` tag arrays.
    const longTag = 'L'.repeat(MAX_TAG_CHARS * 3);
    const many = Array.from({ length: MAX_TAGS + 40 }, (_, i) => `t${i}`);
    const inline = `[${longTag}, ${many.join(', ')}]`;
    const file = write(`---\nsummary: ok\ntags: ${inline}\nstored: 2026-01-01\n---\nbody\n`);
    const entries = parseEntriesFromFile(file, dir, 'proj');
    expect(entries).toHaveLength(1);
    expect(entries[0].tags.length).toBeLessThanOrEqual(MAX_TAGS);
    for (const t of entries[0].tags) expect(t.length).toBeLessThanOrEqual(MAX_TAG_CHARS);
  });

  it('leaves normal-sized frontmatter untouched', () => {
    const file = write(`---\nsummary: A concise summary\ntags: [alpha, beta]\nstored: 2026-01-01\n---\nbody\n`);
    const entries = parseEntriesFromFile(file, dir, 'proj');
    expect(entries[0].summary).toBe('A concise summary');
    expect(entries[0].tags).toEqual(['alpha', 'beta']);
  });
});
