/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `compactToolResponsesInHistory` prunes oversized Gemini functionResponse text
 * in place. It now routes through the Unicode-safe `pruneToolResultText` instead
 * of a UTF-16 `slice`, so a multibyte code point (Mongolian, emoji) that
 * straddles the cut point is no longer split into a broken half-character. These
 * tests drive the real function against a mocked client and assert on the
 * mutated history.
 */
import { describe, it, expect } from 'vitest';
import { compactToolResponsesInHistory } from '@/process/agent/gemini/utils';

type Part = { functionResponse?: { response?: unknown } };
type Content = { role: string; parts: Part[] };

/** A minimal GeminiClient stand-in: initialized, returns/accepts the history. */
function makeClient(history: Content[]): never {
  let current = history;
  return {
    isInitialized: () => true,
    getHistory: () => current,
    setHistory: (h: Content[]) => {
      current = h;
    },
  } as never;
}

/** Any lone surrogate (an unpaired half) means a code point was split. */
function hasBrokenSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

function outputOf(history: Content[]): string {
  const resp = history[0].parts[0].functionResponse?.response as { output?: string };
  return resp.output ?? '';
}

describe('compactToolResponsesInHistory - Unicode-safe pruning', () => {
  it('prunes an oversized response.output without splitting a surrogate pair', () => {
    // 11000 code points of a surrogate-pair emoji (each 2 UTF-16 units), over the
    // 10000 code-point threshold: the old slice(0, 2000) counted UTF-16 units and
    // would land inside an emoji, leaving a lone surrogate.
    // A 1-char ASCII prefix makes the byte offsets odd, so a UTF-16 slice(0, N)
    // lands INSIDE an emoji's surrogate pair - exactly the bug a code-point cut avoids.
    const big = 'x' + '\u{1F3B5}'.repeat(11000);
    const history: Content[] = [{ role: 'user', parts: [{ functionResponse: { response: { output: big } } }] }];

    compactToolResponsesInHistory(makeClient(history));

    const out = outputOf(history);
    expect(out.length, 'the oversized output was pruned').toBeLessThan(big.length);
    expect(hasBrokenSurrogate(out), 'no code point was split').toBe(false);
    expect(out, 'the re-read hint is preserved').toContain('read_file');
  });

  it('prunes a raw-string response the same way', () => {
    // A 1-char ASCII prefix makes the byte offsets odd, so a UTF-16 slice(0, N)
    // lands INSIDE an emoji's surrogate pair - exactly the bug a code-point cut avoids.
    const big = 'x' + '\u{1F3B5}'.repeat(11000);
    const history: Content[] = [{ role: 'user', parts: [{ functionResponse: { response: big } }] }];

    compactToolResponsesInHistory(makeClient(history));

    const out = outputOf(history);
    expect(out.length).toBeLessThan(big.length);
    expect(hasBrokenSurrogate(out)).toBe(false);
    expect(out).toContain('read_file');
  });

  it('leaves a within-budget output untouched', () => {
    const small = 'short tool output';
    const history: Content[] = [{ role: 'user', parts: [{ functionResponse: { response: { output: small } } }] }];

    compactToolResponsesInHistory(makeClient(history));

    expect(outputOf(history)).toBe(small);
  });
});
