/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `compress` - the single entry point for prompt token compression.
 *
 * Routes to one of four modes and reports how much was saved:
 *   - `off`        - identity.
 *   - `lite`       - LOSSLESS formatting normalization (ANSI strip + insignificant
 *                    whitespace). Never removes a word; the sequence of
 *                    non-whitespace characters is preserved, so no code token,
 *                    URL, or JSON value can change. Idempotent.
 *   - `balanced`   - guard code/URLs/JSON, run RTK (terminal-chrome removal) then
 *                    the conservative Caveman filler rules, restore guarded spans.
 *   - `aggressive` - as balanced, with the full Caveman filler set.
 *
 * `balanced`/`aggressive` are lossy on PROSE only: the four guarded span types
 * are always restored verbatim, so code/URLs/JSON are never corrupted.
 */

import type { CompressionMode } from '@/common/types/compression';
import { rtk, rtkLossless } from './rtk';
import { applyCavemanRules, caveman, cavemanModerate } from './caveman';
import { protect, restore } from './guard';

export interface CompressionResult {
  /** The compressed text. */
  text: string;
  /** Character count of the original input. */
  originalChars: number;
  /** Character count of the compressed output. */
  compressedChars: number;
  /**
   * Fraction of characters removed, in [0, 1]. `(original - compressed) / original`,
   * clamped at 0 (a mode never grows the text). 0 for empty input.
   */
  savedRatio: number;
}

/**
 * Lossy pipeline for balanced/aggressive: guard the protected spans ONCE, then
 * run RTK and the caveman rules on the masked prose, then restore. Guarding
 * before RTK is what stops RTK's line-noise removal from touching a code block
 * that happens to contain a border/decoration line.
 */
function runPipeline(text: string, level: 'moderate' | 'full'): string {
  const { masked, tokens } = protect(text);
  const cleaned = rtk(masked);
  const shrunk = applyCavemanRules(cleaned, level);
  return restore(shrunk, tokens);
}

function transform(text: string, mode: CompressionMode): string {
  switch (mode) {
    case 'off':
      return text;
    case 'lite':
      return rtkLossless(text);
    case 'balanced':
      return runPipeline(text, 'moderate');
    case 'aggressive':
      return runPipeline(text, 'full');
    default:
      return text;
  }
}

/**
 * Compress `text` under `mode`, returning the result plus before/after sizes and
 * the saved ratio. Pure and deterministic; never throws for well-formed string
 * input.
 */
export function compress(text: string, mode: CompressionMode): CompressionResult {
  const originalChars = text.length;
  const out = transform(text, mode);
  const compressedChars = out.length;
  const savedRatio = originalChars === 0 ? 0 : Math.max(0, (originalChars - compressedChars) / originalChars);
  return { text: out, originalChars, compressedChars, savedRatio };
}

export { rtk, rtkLossless, caveman, cavemanModerate };
