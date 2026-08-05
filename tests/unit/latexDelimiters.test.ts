/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { convertLatexDelimiters } from '@/renderer/utils/chat/latexDelimiters';

describe('convertLatexDelimiters', () => {
  describe('block math \\[...\\]', () => {
    it('should convert \\[...\\] to $$...$$', () => {
      expect(convertLatexDelimiters('\\[E = mc^2\\]')).toBe('$$E = mc^2$$');
    });

    it('should handle multiline block math', () => {
      const input = '\\[\n\\frac{a}{b} + c\n\\]';
      const expected = '$$\n\\frac{a}{b} + c\n$$';
      expect(convertLatexDelimiters(input)).toBe(expected);
    });

    it('should handle multiple block math expressions', () => {
      const input = '\\[x^2\\] and \\[y^2\\]';
      const expected = '$$x^2$$ and $$y^2$$';
      expect(convertLatexDelimiters(input)).toBe(expected);
    });
  });

  describe('inline math \\(...\\)', () => {
    it('should convert \\(...\\) to $...$', () => {
      expect(convertLatexDelimiters('The value \\(x + y\\) is positive')).toBe('The value $x + y$ is positive');
    });

    it('should handle multiple inline math expressions', () => {
      const input = 'Given \\(a\\) and \\(b\\)';
      const expected = 'Given $a$ and $b$';
      expect(convertLatexDelimiters(input)).toBe(expected);
    });
  });

  describe('mixed math types', () => {
    it('should handle both block and inline math', () => {
      const input = 'Inline \\(x\\) and block:\n\\[x^2 + y^2 = z^2\\]';
      const expected = 'Inline $x$ and block:\n$$x^2 + y^2 = z^2$$';
      expect(convertLatexDelimiters(input)).toBe(expected);
    });
  });

  describe('code block preservation', () => {
    it('should not convert inside fenced code blocks', () => {
      const input = '```\n\\[E = mc^2\\]\n```';
      expect(convertLatexDelimiters(input)).toBe(input);
    });

    it('should not convert inside tilde-fenced code blocks', () => {
      const input = '~~~\n\\[E = mc^2\\]\n~~~';
      expect(convertLatexDelimiters(input)).toBe(input);
    });

    it('should not convert inside inline code', () => {
      const input = 'Use `\\[x\\]` for display math';
      expect(convertLatexDelimiters(input)).toBe(input);
    });

    it('should convert outside code but preserve inside code', () => {
      const input = '\\[a + b\\]\n```\n\\[c + d\\]\n```\n\\[e + f\\]';
      const expected = '$$a + b$$\n```\n\\[c + d\\]\n```\n$$e + f$$';
      expect(convertLatexDelimiters(input)).toBe(expected);
    });
  });

  describe('existing dollar delimiters', () => {
    it('should not affect existing $...$ syntax', () => {
      const input = '$x + y$ and $$a + b$$';
      expect(convertLatexDelimiters(input)).toBe(input);
    });
  });

  describe('no math content', () => {
    it('should return plain text unchanged', () => {
      const input = 'Hello, this is just normal text.';
      expect(convertLatexDelimiters(input)).toBe(input);
    });

    it('should handle empty string', () => {
      expect(convertLatexDelimiters('')).toBe('');
    });
  });

  describe('currency is not rendered as math', () => {
    // remark-math pairs two bare `$` into an inline-math span, so a sentence
    // mentioning two prices rendered as italic KaTeX with the spaces collapsed
    // and both dollar signs eaten.
    it('escapes a single dollar amount so it stays literal text', () => {
      expect(convertLatexDelimiters('the $2k cohort')).toBe('the \\$2k cohort');
    });

    it('escapes both amounts in a range rather than pairing them into math', () => {
      expect(convertLatexDelimiters('between $5 and $10')).toBe('between \\$5 and \\$10');
    });

    it('handles the amounts an agent actually writes', () => {
      expect(convertLatexDelimiters('$25, $10k, $50k+ and $1.5M')).toBe('\\$25, \\$10k, \\$50k+ and \\$1.5M');
    });

    it('leaves an already-escaped dollar alone', () => {
      expect(convertLatexDelimiters('costs \\$5')).toBe('costs \\$5');
    });

    it('leaves $$ display math alone', () => {
      expect(convertLatexDelimiters('$$1 + 2$$')).toBe('$$1 + 2$$');
    });

    it('leaves real inline math alone - it starts with a non-digit', () => {
      expect(convertLatexDelimiters('$x + y$')).toBe('$x + y$');
      expect(convertLatexDelimiters('\\$\\alpha$')).toBe('\\$\\alpha$');
    });

    it('still converts inline math that begins with a digit', () => {
      // The currency guard runs BEFORE delimiter conversion, so math produced by
      // that conversion is never re-examined and escaped by it.
      expect(convertLatexDelimiters('\\(5x + 3\\)')).toBe('$5x + 3$');
    });
  });
});
