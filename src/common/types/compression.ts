/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prompt token-compression modes.
 *
 * Applied to the outgoing prompt at the single stateless completion primitive
 * (`oneShotComplete`) so every background caller shrinks its token cost before
 * the provider call. Lives in `src/common` because the type is shared across
 * the process (compression engine + config), the bridge contract, and any
 * renderer Settings selector.
 *
 * - `off`        - identity; the prompt is sent verbatim.
 * - `lite`       - LOSSLESS formatting normalization only (strip ANSI escape
 *                  codes + insignificant end-of-line / blank-line whitespace).
 *                  Never removes a word, and never alters a code token, URL, or
 *                  JSON value. The safe default.
 * - `balanced`   - lite's cleanup plus terminal-chrome removal (RTK) and a
 *                  conservative pass of prose-filler rules (moderate Caveman).
 * - `aggressive` - RTK plus the full prose-filler rule set.
 *
 * Only `off` and `lite` are guaranteed content-preserving; `balanced` and
 * `aggressive` strip prose filler but still never corrupt fenced/inline code,
 * URLs, or JSON (those spans are guarded and restored verbatim).
 */
export type CompressionMode = 'off' | 'lite' | 'balanced' | 'aggressive';

/** Ordered, canonical list of every valid {@link CompressionMode}. */
export const COMPRESSION_MODES: readonly CompressionMode[] = ['off', 'lite', 'balanced', 'aggressive'];

/** Runtime type guard for an untrusted value claiming to be a {@link CompressionMode}. */
export function isCompressionMode(value: unknown): value is CompressionMode {
  return typeof value === 'string' && (COMPRESSION_MODES as readonly string[]).includes(value);
}
