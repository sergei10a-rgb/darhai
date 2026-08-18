/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the spill POLICY: when a result exceeds the inline cap it is written
 * to disk verbatim and replaced by a bounded preview + locator; when it does not,
 * or when the spill cannot happen, the original is kept inline. The best-effort
 * arms are proofs that a spill failure never loses or hides the tool output.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spillText, SPILL_DEFAULT_MAX_INLINE_BYTES, type SpillTextResult } from '@process/services/spill/spillText';

/** Narrow a result the caller has already asserted is inline (spilled === false). */
type InlineSpillResult = Extract<SpillTextResult, { spilled: false }>;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'darhai-spilltext-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('spillText', () => {
  it('keeps a within-cap result inline', async () => {
    const r = await spillText({ sessionId: 's1', toolName: 'grep', content: 'small' }, { maxInlineBytes: 100, root });
    expect(r.spilled).toBe(false);
  });

  it('spills an oversized result to a verbatim file and returns a bounded preview', async () => {
    // Cap of 2 KB leaves ample room for the locator notice even under a long
    // Windows temp path, so the preview budget is comfortably positive.
    const cap = 2048;
    const content = 'START' + 'x'.repeat(8000) + 'END';
    const r = await spillText({ sessionId: 's1', toolName: 'grep', content }, { maxInlineBytes: cap, root });

    expect(r.spilled).toBe(true);
    if (!r.spilled) return; // narrow
    // The full content is on disk, byte-for-byte.
    expect(readFileSync(r.locator, 'utf8')).toBe(content);
    expect(r.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    // The replacement stays within the advertised cap and names the locator.
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(cap);
    expect(r.text).toContain(r.locator);
    expect(r.text).toContain('bytes omitted');
    // Head and tail of the original survive in the preview.
    expect(r.text).toContain('START');
    expect(r.text).toContain('END');
  });

  it('never splits a multi-byte character in the preview', async () => {
    const content = '🚀'.repeat(3000); // 4 bytes each in UTF-8
    const r = await spillText({ sessionId: 's1', toolName: 'grep', content }, { maxInlineBytes: 2048, root });
    expect(r.spilled).toBe(true);
    if (!r.spilled) return;
    // A byte-level slice through an emoji would produce U+FFFD on decode; a
    // code-point-safe cut keeps every retained rocket whole.
    expect(r.text).not.toContain('�');
  });

  it('keeps inline when there is no session owner (best-effort)', async () => {
    const content = 'x'.repeat(5000);
    const r = await spillText({ sessionId: '', toolName: 'grep', content }, { maxInlineBytes: 100, root });
    expect(r.spilled).toBe(false);
    if (r.spilled) return;
    expect((r as InlineSpillResult).error).toMatch(/no session owner/);
  });

  it('keeps inline when the write fails, surfacing the error (best-effort)', async () => {
    // Point the root at a regular file so mkdir under it fails - a real storage
    // error that must degrade to inline, not throw.
    const filePath = join(root, 'not-a-dir');
    (await import('node:fs')).writeFileSync(filePath, 'x');
    const content = 'x'.repeat(5000);
    const r = await spillText({ sessionId: 's1', toolName: 'grep', content }, { maxInlineBytes: 100, root: filePath });
    expect(r.spilled).toBe(false);
    if (r.spilled) return;
    expect((r as InlineSpillResult).error).toBeTruthy();
  });

  it('keeps inline when the notice alone would exceed a tiny cap', async () => {
    // A 10-byte cap cannot hold the locator notice, so there is no within-cap
    // replacement: the policy declines rather than emit something over the cap.
    const content = 'x'.repeat(5000);
    const r = await spillText({ sessionId: 's1', toolName: 'grep', content }, { maxInlineBytes: 10, root });
    expect(r.spilled).toBe(false);
  });

  it('rejects an invalid cap', async () => {
    await expect(
      spillText({ sessionId: 's1', toolName: 'grep', content: 'x' }, { maxInlineBytes: -1, root })
    ).rejects.toThrow(/non-negative integer/);
  });

  it('exposes a measured default cap above the pruner threshold', () => {
    // 32 KB: a quarter of a typical 32K-token local window; above the pruner's
    // 8192-code-point budget so prunable results are pruned, not spilled.
    expect(SPILL_DEFAULT_MAX_INLINE_BYTES).toBe(32768);
  });
});
