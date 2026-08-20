/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the shared token counter.
 *
 * The oracle is `gpt-tokenizer` imported directly, so these tests fail if the
 * module ever silently drifts back to a character heuristic.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { countTokens as o200k } from 'gpt-tokenizer/encoding/o200k_base';
import {
  TOKEN_COUNTER_LABEL,
  TOKEN_ERROR_TOKENS,
  TOKEN_WARNING_TOKENS,
  charsDivFourTokens,
  estimateTokens,
  getLoadedTokenEncoder,
  loadTokenEncoder,
  tokenLevel,
} from '@/common/utils/tokenCount';

const CYRILLIC = `Тоо, босго, хязгаарыг хэзээ ч бүү таа — хэмж. Завсрын биш эцсийн
гаралтыг хэмж. Шалгуураа эсрэгээр нь шалга.
`.repeat(20);

const ASCII = `Never guess a number, a threshold, or a limit - measure it.
Measure the final output, not an intermediate proxy.
`.repeat(20);

describe('tokenCount', () => {
  describe('without an encoder', () => {
    it('falls back to the character heuristic and says so', () => {
      const estimate = estimateTokens(CYRILLIC);
      expect(estimate.counter).toBe('chars-div-4');
      expect(estimate.tokens).toBe(Math.ceil(CYRILLIC.length / 4));
    });

    it('never presents a fallback number as a real token count', () => {
      // The label is the only thing standing between the user and a confident
      // looking lie, so it must differ between the two counters.
      expect(TOKEN_COUNTER_LABEL['chars-div-4']).not.toBe(TOKEN_COUNTER_LABEL.o200k_base);
    });

    it('falls back when the encoder throws instead of propagating', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const estimate = estimateTokens('abc', () => {
        throw new Error('boom');
      });
      expect(estimate).toEqual({ tokens: 1, counter: 'chars-div-4' });
      errSpy.mockRestore();
    });
  });

  describe('with the real encoder', () => {
    beforeAll(async () => {
      await loadTokenEncoder();
    });

    it('loads an encoder and exposes it synchronously afterwards', () => {
      expect(getLoadedTokenEncoder()).toBeTypeOf('function');
    });

    it('matches the real tokenizer exactly on Cyrillic', () => {
      const estimate = estimateTokens(CYRILLIC, getLoadedTokenEncoder());
      expect(estimate.counter).toBe('o200k_base');
      expect(estimate.tokens).toBe(o200k(CYRILLIC));
    });

    it('is far from the character heuristic on Cyrillic - that is the bug', () => {
      const truth = o200k(CYRILLIC);
      expect(charsDivFourTokens(CYRILLIC)).toBeLessThan(truth * 0.75);
    });

    it('matches the real tokenizer exactly on ASCII too', () => {
      const estimate = estimateTokens(ASCII, getLoadedTokenEncoder());
      expect(estimate.counter).toBe('o200k_base');
      expect(estimate.tokens).toBe(o200k(ASCII));
    });

    it('caches the loader instead of re-parsing the 2.4 MB rank table', async () => {
      const a = await loadTokenEncoder();
      const b = await loadTokenEncoder();
      expect(a).toBe(b);
    });
  });

  describe('tokenLevel', () => {
    it('classifies against the documented ceilings', () => {
      expect(tokenLevel(0)).toBe('ok');
      expect(tokenLevel(TOKEN_WARNING_TOKENS - 1)).toBe('ok');
      expect(tokenLevel(TOKEN_WARNING_TOKENS)).toBe('warning');
      expect(tokenLevel(TOKEN_ERROR_TOKENS - 1)).toBe('warning');
      expect(tokenLevel(TOKEN_ERROR_TOKENS)).toBe('error');
    });

    it('keeps the ceilings the UI copy claims', () => {
      // The warning string says "~2,000 tokens". If these move, that copy and
      // all 13 locale files have to move with them.
      expect(TOKEN_WARNING_TOKENS).toBe(2000);
      expect(TOKEN_ERROR_TOKENS).toBe(3000);
    });
  });
});
