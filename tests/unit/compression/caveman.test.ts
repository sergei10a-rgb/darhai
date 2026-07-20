/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for Caveman (prose-filler removal). Verifies filler is removed while
 * the four guarded span types (fenced code, inline code, URLs, JSON) are never
 * altered, plus idempotency. Pure functions, no mocks.
 */

import { describe, it, expect } from 'vitest';
import { caveman, cavemanModerate } from '@process/services/compression/caveman';

describe('caveman', () => {
  it('removes filler words and wordy phrasings from prose', () => {
    const input = 'Please note that in order to run the tests you basically just need node.';
    const out = caveman(input);
    expect(out).not.toMatch(/\bplease\b/i);
    expect(out).not.toMatch(/in order to/i);
    expect(out).not.toMatch(/\bbasically\b/i);
    expect(out).toContain('to run the tests');
    expect(out).toContain('node');
  });

  it('never alters a fenced code block', () => {
    const code = '```js\nconst please = 1; // in order to test\nfunction basically() {}\n```';
    expect(caveman(code)).toBe(code);
  });

  it('never alters inline code', () => {
    const out = caveman('Call `please_run(in_order_to)` now.');
    expect(out).toContain('`please_run(in_order_to)`');
  });

  it('never alters URLs', () => {
    const url = 'https://example.com/please/in-order-to/basically?x=just';
    expect(caveman(url)).toBe(url);
    const out = caveman('See https://example.com/please/just here, please.');
    expect(out).toContain('https://example.com/please/just');
  });

  it('never alters JSON-looking spans', () => {
    const json = '{"please": "in order to", "list": ["just", "basically"]}';
    expect(caveman(json)).toBe(json);
  });

  it('round-trips a pure code / URL / JSON string unchanged (property-style)', () => {
    const samples = [
      '```py\nplease = "just do it"\n```',
      '`const x = please.just`',
      'https://a.example/please/just/in-order-to',
      '{"a": "please just basically", "b": [1, 2, 3]}',
    ];
    for (const sample of samples) {
      expect(caveman(sample)).toBe(sample);
    }
  });

  it('is idempotent on already-compressed text', () => {
    const input = 'Please, in order to win, you really just need to basically try.';
    const once = caveman(input);
    expect(caveman(once)).toBe(once);
  });

  it('protects code even when surrounded by filler prose', () => {
    const input = 'Please just call `keepMe(please, just)` in order to finish.';
    const out = caveman(input);
    expect(out).toContain('`keepMe(please, just)`');
    expect(out).not.toMatch(/\bin order to\b/i);
  });
});

describe('cavemanModerate', () => {
  it('applies the conservative subset but leaves aggressive-only fillers', () => {
    const input = 'Please, in order to win you just need to try.';
    const out = cavemanModerate(input);
    expect(out).not.toMatch(/\bplease\b/i);
    expect(out).not.toMatch(/in order to/i);
    // "just" is aggressive-only; the moderate pass keeps it.
    expect(out).toMatch(/\bjust\b/i);
  });

  it('is idempotent', () => {
    const input = 'Please note that due to the fact that it works, it is worth noting that we ship.';
    const once = cavemanModerate(input);
    expect(cavemanModerate(once)).toBe(once);
  });
});
