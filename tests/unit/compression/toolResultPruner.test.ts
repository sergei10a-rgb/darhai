/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the deterministic tool-result pruner. Proves it leaves
 * within-budget results untouched, cuts ONLY the middle of oversized ones
 * (head + marker + tail), never splits a surrogate pair, preserves rich-block
 * order, shadow-prices the removal, and rejects an incoherent budget.
 *
 * The Unicode-safety and middle-only assertions are mutation proofs: if the
 * slicing regressed to UTF-16 `String.prototype.slice` a retained boundary would
 * split a surrogate pair, and if head/tail retention were dropped the kept ends
 * would disappear. Pure functions, no mocks.
 */

import { describe, it, expect } from 'vitest';
import {
  codePointLength,
  DEFAULTS,
  PRUNE_MARKER,
  pruneToolResultBlocks,
  pruneToolResultText,
  resolveToolResultPruneConfig,
  type ToolResultBlock,
} from '@process/services/compression/toolResultPruner';

/** Matches a lone (unpaired) UTF-16 surrogate - the signature of a split astral char. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A small, coherent budget for fast tests: head 40 + marker + tail 20 <= 100. */
const SMALL = { thresholdChars: 100, headChars: 40, tailChars: 20 } as const;

describe('codePointLength', () => {
  it('counts astral characters as one code point, not two code units', () => {
    // Rocket emoji is one code point but two UTF-16 code units.
    expect('🚀'.length).toBe(2);
    expect(codePointLength('🚀')).toBe(1);
    expect(codePointLength('a🚀b')).toBe(3);
  });
});

describe('resolveToolResultPruneConfig', () => {
  it('fills defaults', () => {
    expect(resolveToolResultPruneConfig()).toEqual(DEFAULTS);
  });

  it('rejects an unknown key', () => {
    // @ts-expect-error - deliberately invalid key
    expect(() => resolveToolResultPruneConfig({ nope: 1 })).toThrow(/unknown key/);
  });

  it('rejects a budget whose emitted size exceeds the threshold', () => {
    expect(() => resolveToolResultPruneConfig({ thresholdChars: 10, headChars: 8, tailChars: 8 })).toThrow(
      /at most thresholdChars/
    );
  });

  it('rejects a non-positive threshold and negative head/tail', () => {
    expect(() => resolveToolResultPruneConfig({ thresholdChars: 0 })).toThrow(/positive integer/);
    expect(() => resolveToolResultPruneConfig({ headChars: -1 })).toThrow(/non-negative integer/);
  });
});

describe('pruneToolResultText', () => {
  it('leaves a within-threshold result byte-identical and unpruned', () => {
    const text = 'a'.repeat(SMALL.thresholdChars);
    const r = pruneToolResultText(text, SMALL);
    expect(r.pruned).toBe(false);
    expect(r.text).toBe(text);
    expect(r.charsRemoved).toBe(0);
  });

  it('cuts only the middle: keeps head and tail, drops the interior', () => {
    const head = 'H'.repeat(SMALL.headChars);
    const middle = 'M'.repeat(500);
    const tail = 'T'.repeat(SMALL.tailChars);
    const r = pruneToolResultText(head + middle + tail, SMALL);

    expect(r.pruned).toBe(true);
    expect(r.text.startsWith(head)).toBe(true); // head retained verbatim
    expect(r.text.endsWith(tail)).toBe(true); // tail retained verbatim
    expect(r.text).toContain(PRUNE_MARKER); // interior replaced by the marker
    expect(r.text).not.toContain('M'); // no interior byte survived
  });

  it('reports the shadow-price (charsRemoved = before - after)', () => {
    const text = 'x'.repeat(1000);
    const r = pruneToolResultText(text, SMALL);
    expect(r.charsBefore).toBe(1000);
    expect(r.charsAfter).toBe(codePointLength(r.text));
    expect(r.charsRemoved).toBe(r.charsBefore - r.charsAfter);
    expect(r.charsRemoved).toBeGreaterThan(0);
  });

  it('never splits a surrogate pair at the head boundary (Unicode-safe)', () => {
    // Place rocket emojis so the head cut lands exactly on a surrogate pair.
    // A UTF-16 `.slice(0, headChars)` would leave a lone high surrogate here.
    const head = '🚀'.repeat(SMALL.headChars); // headChars code points, 2x code units
    const tail = '🎯'.repeat(SMALL.tailChars);
    const filler = '🔥'.repeat(300);
    const r = pruneToolResultText(head + filler + tail, SMALL);

    expect(r.pruned).toBe(true);
    expect(LONE_SURROGATE.test(r.text)).toBe(false); // no split astral char anywhere
    expect(codePointLength(r.text.split(PRUNE_MARKER)[0])).toBe(SMALL.headChars);
  });

  it('omits the tail entirely when tailChars is 0', () => {
    const r = pruneToolResultText('z'.repeat(1000), { thresholdChars: 100, headChars: 40, tailChars: 0 });
    expect(r.text.endsWith(PRUNE_MARKER)).toBe(true);
  });
});

describe('pruneToolResultBlocks', () => {
  const image: ToolResultBlock = { type: 'image' };

  it('leaves within-budget blocks untouched', () => {
    const blocks: ToolResultBlock[] = [{ type: 'text', text: 'short' }, image];
    const r = pruneToolResultBlocks(blocks, SMALL);
    expect(r.pruned).toBe(false);
    expect(r.blocks).toBe(blocks);
  });

  it('preserves non-text block order while pruning the combined text', () => {
    const blocks: ToolResultBlock[] = [
      { type: 'text', text: 'H'.repeat(60) },
      image,
      { type: 'text', text: 'M'.repeat(400) },
      image,
      { type: 'text', text: 'T'.repeat(60) },
    ];
    const r = pruneToolResultBlocks(blocks, SMALL);

    expect(r.pruned).toBe(true);
    // Both images are still present and still in order relative to each other.
    const kinds = r.blocks.map((b) => b.type);
    expect(kinds.filter((k) => k === 'image')).toHaveLength(2);
    expect(kinds.indexOf('image')).toBeLessThan(kinds.lastIndexOf('image'));
    // The marker landed exactly once, in a text block.
    const allText = r.blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    expect(allText.split(PRUNE_MARKER)).toHaveLength(2);
    expect(r.charsRemoved).toBeGreaterThan(0);
  });

  it('does not split a surrogate pair spread across the block sequence', () => {
    const blocks: ToolResultBlock[] = [
      { type: 'text', text: '🚀'.repeat(60) },
      image,
      { type: 'text', text: '🔥'.repeat(300) },
      { type: 'text', text: '🎯'.repeat(60) },
    ];
    const r = pruneToolResultBlocks(blocks, SMALL);
    for (const b of r.blocks) {
      if (b.type === 'text') expect(LONE_SURROGATE.test((b as { text: string }).text)).toBe(false);
    }
  });
});
