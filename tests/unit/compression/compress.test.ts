/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the `compress` entry point across all four modes. Proves that
 * `off` is identity, `lite` is lossless + idempotent, and balanced/aggressive
 * shrink the text while never corrupting guarded spans. Pure functions, no mocks.
 */

import { describe, it, expect } from 'vitest';
import { compress } from '@process/services/compression/compress';

const ESC = String.fromCharCode(0x1b);

/** Strip every whitespace character, leaving only the visible glyph sequence. */
const noWs = (s: string): string => s.replace(/\s+/g, '');

describe('compress', () => {
  it("mode 'off' is the identity", () => {
    const input = `${ESC}[31mhi${ESC}[0m   \n\n\nplease do it`;
    const r = compress(input, 'off');
    expect(r.text).toBe(input);
    expect(r.originalChars).toBe(input.length);
    expect(r.compressedChars).toBe(input.length);
    expect(r.savedRatio).toBe(0);
  });

  describe("'lite' is lossless", () => {
    it('is the identity on clean prose/code (no words removed, no meaning changed)', () => {
      const input = 'const please = 1; // in order to keep it\nreturn please;';
      expect(compress(input, 'lite').text).toBe(input);
    });

    it('strips only ANSI + insignificant whitespace, never a visible glyph', () => {
      const input = `${ESC}[32mconst x = 1;${ESC}[0m   \n\n\n\nreturn x;   `;
      const r = compress(input, 'lite');
      const ansiStripped = input.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
      expect(noWs(r.text)).toBe(noWs(ansiStripped)); // same visible characters
      expect(r.compressedChars).toBeLessThan(r.originalChars); // achieved savings
    });

    it('preserves code, URL, JSON, and sentence content exactly', () => {
      const samples = [
        '```js\nconst please = just(1);\n```',
        'https://a.example/please/just',
        '{"please": "just", "n": 1}',
        'Please just run it.',
      ];
      for (const sample of samples) {
        expect(compress(sample, 'lite').text.replace(/\s/g, '')).toBe(sample.replace(/\s/g, ''));
      }
    });

    it('is idempotent', () => {
      const once = compress(`${ESC}[31mx${ESC}[0m  \n\n\n\ny`, 'lite').text;
      expect(compress(once, 'lite').text).toBe(once);
    });
  });

  describe("'balanced' / 'aggressive'", () => {
    const sample = [
      `${ESC}[36mRunning build...${ESC}[0m`,
      '⠇ bundling',
      'Downloading  10%\rDownloading 100%',
      '',
      '',
      '',
      'Please note that in order to finish you basically just wait.',
      'See `keepThisCode()` and https://ex.ample/keep and {"k": "v"}.',
    ].join('\n');

    it('reduces character count and reports savedRatio in (0,1)', () => {
      for (const mode of ['balanced', 'aggressive'] as const) {
        const r = compress(sample, mode);
        expect(r.compressedChars).toBeLessThan(r.originalChars);
        expect(r.savedRatio).toBeGreaterThan(0);
        expect(r.savedRatio).toBeLessThan(1);
        // guarded spans survive verbatim
        expect(r.text).toContain('`keepThisCode()`');
        expect(r.text).toContain('https://ex.ample/keep');
        expect(r.text).toContain('{"k": "v"}');
        // terminal chrome removed
        expect(r.text).not.toContain(ESC);
        expect(r.text).not.toContain('bundling');
      }
    });

    it('aggressive removes at least as much as balanced', () => {
      const b = compress(sample, 'balanced').compressedChars;
      const a = compress(sample, 'aggressive').compressedChars;
      expect(a).toBeLessThanOrEqual(b);
    });
  });

  it('handles empty and whitespace-only input safely', () => {
    for (const mode of ['off', 'lite', 'balanced', 'aggressive'] as const) {
      expect(() => compress('', mode)).not.toThrow();
      expect(compress('', mode)).toMatchObject({ originalChars: 0, savedRatio: 0 });
      expect(() => compress('   \n\t\n  ', mode)).not.toThrow();
    }
  });
});
