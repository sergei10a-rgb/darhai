/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic, model-free tool-result pruner. Where `compress` (RTK/caveman)
 * shrinks PROSE by removing filler and terminal chrome, this pruner answers a
 * different problem: a single tool result whose text is simply too large for the
 * context window at all (a 200 KB grep dump, a `read` of a giant file). Prose
 * compression is the wrong tool for that - it cannot make a 200 KB listing small
 * enough, and it would mangle the structured content besides.
 *
 * The pruner instead keeps a bounded HEAD and TAIL of the text and replaces the
 * middle with a single fixed marker, so the model keeps the start (usually the
 * command/context and first hits) and the end (usually the summary/exit status)
 * of an oversized result while the bulk that no longer fits is dropped. It is:
 *   - Unicode-safe: slicing is by Unicode code point (`Array.from`), never by
 *     UTF-16 code unit, so a retained boundary can never split a surrogate pair
 *     (an emoji / CJK-extension char is kept whole or dropped whole).
 *   - Rich-block-order preserving: for structured tool results (an array of
 *     `text` and non-text blocks), non-text blocks (images, diffs) are kept in
 *     place and only the text is pruned across the sequence.
 *   - Shadow-priced: every prune reports `charsRemoved` so a caller can log how
 *     much context the prune reclaimed - the size cut is never silent.
 *
 * Pure and deterministic; no I/O, no mutation of inputs.
 */

/**
 * Fixed marker substituted for every removed middle span. Carries its own blank
 * lines so it reads as a clear break in both plain text and Markdown, and is
 * counted against the emitted-size budget in {@link resolveToolResultPruneConfig}.
 */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n';

/** Raw, all-optional pruning budget. */
export interface ToolResultPruneConfig {
  /**
   * Prune only when the total text exceeds this many Unicode code points.
   * Default {@link DEFAULTS.thresholdChars}.
   */
  thresholdChars?: number;
  /** Maximum leading code points retained. Default {@link DEFAULTS.headChars}. */
  headChars?: number;
  /** Maximum trailing code points retained. Default {@link DEFAULTS.tailChars}. */
  tailChars?: number;
}

/** Validated, immutable pruning budget. */
export interface ResolvedToolResultPruneConfig {
  readonly thresholdChars: number;
  readonly headChars: number;
  readonly tailChars: number;
}

/**
 * Low-friction defaults for local coding-agent tool output.
 *
 * MEASURED, not guessed. Context is the scarcest resource on an 8 GB local model
 * (memory: `feedback-machine-limits-are-not-project-limits` notwithstanding, the
 * WINDOW is a hard model property): a typical local model Darhai routes to
 * (Qwen2.5-7B, gemma) exposes a 32K-token context, and English text runs ~4
 * chars/token, so 32K tokens is ~128 KB of text TOTAL for the whole
 * conversation. An 8192-code-point threshold is ~2K tokens - one oversized tool
 * result at the default budget costs ~6% of a 32K window, and a single 200 KB
 * grep dump left inline would be ~50K tokens, larger than the entire window.
 * Keeping 4096 head + 1024 tail retains the command echo and first hits plus the
 * final summary/exit line, which is where a coding tool's actionable content sits.
 */
export const DEFAULTS: ResolvedToolResultPruneConfig = {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
};

const CONFIG_KEYS: ReadonlySet<string> = new Set(['thresholdChars', 'headChars', 'tailChars']);

/**
 * A generic tool-result content block. Deliberately structural (not an import of
 * any one backend's `Part`/`ContentBlock`) so the pruner stays backend-agnostic:
 * a `text` block is prunable, any other block is opaque and preserved verbatim.
 */
export type ToolResultBlock = { readonly type: 'text'; readonly text: string } | { readonly type: string };

/** Narrow a block to the prunable text variant without an `any` cast. */
function isTextBlock(block: ToolResultBlock): block is { readonly type: 'text'; readonly text: string } {
  return block.type === 'text' && typeof (block as { text?: unknown }).text === 'string';
}

/**
 * Count text in Unicode code points, never UTF-16 code units. `Array.from`
 * iterates by code point, so an astral character (emoji, CJK extension) counts
 * as one - the same unit the slicing below uses, so measurement and cut agree.
 * @param text - text to measure.
 * @returns the Unicode code-point count.
 */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a positive integer`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a non-negative integer`);
  }
}

/**
 * Resolve and validate a pruning budget, filling defaults and rejecting an
 * incoherent one at the call boundary rather than mid-prune.
 *
 * The load-bearing check is `head + marker + tail <= threshold`: without it a
 * "prune" could emit MORE than the threshold it claims to enforce (and, for a
 * marginally-over input, more than the original), which would be a size increase
 * dressed up as a reduction. An unknown key is rejected too, so a typo'd budget
 * fails loudly instead of silently taking a default.
 *
 * @param config - raw budget, all fields optional.
 * @returns a frozen, validated budget.
 */
export function resolveToolResultPruneConfig(config: ToolResultPruneConfig = {}): ResolvedToolResultPruneConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`ToolResultPruneConfig: unknown key "${key}" (allowed: thresholdChars, headChars, tailChars)`);
    }
  }

  const resolved: ResolvedToolResultPruneConfig = {
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars,
  };
  assertPositiveInteger('thresholdChars', resolved.thresholdChars);
  assertNonNegativeInteger('headChars', resolved.headChars);
  assertNonNegativeInteger('tailChars', resolved.tailChars);

  const emittedChars = resolved.headChars + codePointLength(PRUNE_MARKER) + resolved.tailChars;
  if (emittedChars > resolved.thresholdChars) {
    throw new Error(
      `ToolResultPruneConfig: headChars + marker + tailChars (${emittedChars}) ` +
        `must be at most thresholdChars (${resolved.thresholdChars})`
    );
  }
  return Object.freeze(resolved);
}

/** Outcome of pruning one plain-text tool result. */
export interface TextPruneResult {
  /** `true` when the middle was removed; `false` when the text was within budget. */
  readonly pruned: boolean;
  /** The (possibly pruned) text. Identical reference-equal content when not pruned. */
  readonly text: string;
  /** Original size in Unicode code points. */
  readonly charsBefore: number;
  /** Emitted size in Unicode code points. */
  readonly charsAfter: number;
  /** `charsBefore - charsAfter` - the shadow-price of the prune (0 when not pruned). */
  readonly charsRemoved: number;
}

/**
 * Prune one plain-text tool result to `head + marker + tail`, Unicode-safely.
 *
 * Returns the input unchanged (with `pruned: false`) when the text is within the
 * threshold, so a caller can call it unconditionally. When over threshold, the
 * cut points are computed in code-point space and the join is done from the
 * `Array.from` code-point array, so no surrogate pair can be split.
 *
 * @param text - the full tool-result text.
 * @param config - optional budget; defaults applied and validated.
 * @returns the prune outcome, including the shadow-priced `charsRemoved`.
 */
export function pruneToolResultText(text: string, config: ToolResultPruneConfig = {}): TextPruneResult {
  const resolved = resolveToolResultPruneConfig(config);
  const points = Array.from(text);
  const charsBefore = points.length;
  if (charsBefore <= resolved.thresholdChars) {
    return { pruned: false, text, charsBefore, charsAfter: charsBefore, charsRemoved: 0 };
  }

  const head = points.slice(0, resolved.headChars).join('');
  const tail = resolved.tailChars > 0 ? points.slice(charsBefore - resolved.tailChars).join('') : '';
  const out = head + PRUNE_MARKER + tail;
  const charsAfter = codePointLength(out);
  return { pruned: true, text: out, charsBefore, charsAfter, charsRemoved: charsBefore - charsAfter };
}

/** Outcome of pruning a rich (multi-block) tool result. */
export interface BlockPruneResult {
  /** `true` when any text was removed; `false` when total text was within budget. */
  readonly pruned: boolean;
  /** The (possibly rewritten) block sequence. Non-text blocks are preserved in order. */
  readonly blocks: readonly ToolResultBlock[];
  /** Total text size across all `text` blocks before pruning, in code points. */
  readonly charsBefore: number;
  /** Total text size across all `text` blocks after pruning, in code points. */
  readonly charsAfter: number;
  /** `charsBefore - charsAfter` - the shadow-price of the prune (0 when not pruned). */
  readonly charsRemoved: number;
}

/** Sum the code points across every `text` block; non-text blocks cost zero. */
function measureBlocks(blocks: readonly ToolResultBlock[]): number {
  let chars = 0;
  for (const block of blocks) {
    if (isTextBlock(block)) chars += codePointLength(block.text);
  }
  return chars;
}

/**
 * Prune an oversized rich tool result, keeping rich-block ORDER intact.
 *
 * The total text across every `text` block is treated as one logical stream: the
 * first `headChars` code points of that stream are kept, the last `tailChars`
 * are kept, and the removed middle is replaced by a single {@link PRUNE_MARKER}
 * inserted at the first text block that intersects the removed span. Non-text
 * blocks (images, file diffs) are copied through untouched and in place, so an
 * image between two text blocks stays where the model expects it. A text block
 * that ends up empty after the cut is dropped so no zero-length block is emitted.
 *
 * Returns the input unchanged (`pruned: false`) when the combined text is within
 * threshold.
 *
 * @param blocks - the tool-result content blocks.
 * @param config - optional budget; defaults applied and validated.
 * @returns the prune outcome, including the shadow-priced `charsRemoved`.
 */
export function pruneToolResultBlocks(
  blocks: readonly ToolResultBlock[],
  config: ToolResultPruneConfig = {}
): BlockPruneResult {
  const resolved = resolveToolResultPruneConfig(config);
  const charsBefore = measureBlocks(blocks);
  if (charsBefore <= resolved.thresholdChars) {
    return { pruned: false, blocks, charsBefore, charsAfter: charsBefore, charsRemoved: 0 };
  }

  const removedStart = resolved.headChars;
  const removedEnd = charsBefore - resolved.tailChars;
  const out: ToolResultBlock[] = [];
  let consumed = 0;
  let markerInserted = false;

  for (const block of blocks) {
    if (!isTextBlock(block)) {
      out.push(block);
      continue;
    }
    const points = Array.from(block.text);
    const blockStart = consumed;
    const blockEnd = blockStart + points.length;
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
    const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart;
    const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : '';
    if (marker.length > 0) markerInserted = true;
    const nextText = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('');
    if (nextText.length > 0) out.push({ type: 'text', text: nextText });
    consumed = blockEnd;
  }

  const charsAfter = measureBlocks(out);
  return { pruned: true, blocks: out, charsBefore, charsAfter, charsRemoved: charsBefore - charsAfter };
}
