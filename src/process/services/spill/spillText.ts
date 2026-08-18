/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Spill POLICY: decide WHEN a tool result is too large to keep inline, and, when
 * it is, persist the full text to a session-scoped spill artifact and return a
 * bounded head/tail preview plus an opaque locator and a retrieval hint. The
 * model keeps a readable excerpt and a path it can `read`/`grep`, while the bulk
 * of a 200 KB grep dump stops bloating the context window.
 *
 * This is the complement of the pruner: the pruner tightens an over-budget result
 * IN CONTEXT (head + marker + tail), the spill takes an even larger one OUT of
 * context entirely (preview + locator to a file that still holds every byte).
 *
 * BEST-EFFORT BY CONTRACT. A spill failure must never turn a successful tool call
 * into an error or hide its output: when there is no storage backend, no session
 * owner, or the write fails, this returns `spilled: false` and the caller keeps
 * the original inline result. Saving output must not be able to lose it.
 *
 * The file mechanics (private root, traversal-safe naming, exclusive owner-only
 * write) live in {@link ./store}; this file owns only the size decision, the
 * preview, and the notice text.
 */

import { saveTextFile, type SaveTextOptions } from './store';

/**
 * Default inline cap in UTF-8 bytes: a plain-text result larger than this is
 * spilled to disk.
 *
 * MEASURED against the pruner's budget and a local model's window. The pruner's
 * default threshold is 8192 code points (~32 KB at worst for astral-heavy text,
 * ~8 KB for ASCII), and it can keep an over-budget result usefully in context.
 * Spill is for results BEYOND what pruning can salvage: 32 KB (~8K tokens) is a
 * quarter of a typical 32K-token local-model window, so one tool result larger
 * than that genuinely belongs on disk with a locator rather than inline. Set
 * above the pruner threshold on purpose - a result the pruner could keep should
 * be pruned, not spilled.
 */
export const SPILL_DEFAULT_MAX_INLINE_BYTES = 32768;

/** The storage namespace and content for one spill request. */
export interface SpillTextInput {
  /** The owning session id; scopes the on-disk directory. Empty/undefined ⇒ no spill. */
  sessionId: string;
  /** The tool whose result this is (for a readable filename, e.g. `web_fetch`). */
  toolName: string;
  /** The full tool-result text to persist and preview (UTF-8). */
  content: string;
}

/** Policy configuration. */
export interface SpillTextConfig {
  /**
   * Model-facing inline cap in UTF-8 bytes. A result larger than this is spilled.
   * Default {@link SPILL_DEFAULT_MAX_INLINE_BYTES}.
   */
  maxInlineBytes?: number;
  /**
   * Spill root directory. Omitted ⇒ the store's lazy private (0700) default. Set
   * to keep spill files under a known location.
   */
  root?: string;
}

/** Result of a spill decision. */
export type SpillTextResult =
  | {
      /** The text was within the cap (or a failure kept it inline); use the original. */
      readonly spilled: false;
      /** Present only when a spill was attempted and failed best-effort. */
      readonly error?: string;
    }
  | {
      /** The text was spilled; `text` is the bounded replacement to put in context. */
      readonly spilled: true;
      /** Preview (head/tail) + notice with the locator and retrieval hint. */
      readonly text: string;
      /** Absolute path to the full-fidelity spill artifact. */
      readonly locator: string;
      /** UTF-8 byte length of the full spilled content. */
      readonly bytes: number;
    };

/** Retrieval guidance handed to the model alongside the locator. */
const RETRIEVAL_HINT = 'Use read with offset/limit, or grep this path to search within it.';

/**
 * The longest UTF-8 prefix of `text` that fits in `maxBytes`, cut on a Unicode
 * code-point boundary so a multi-byte character is never split. Returns the
 * prefix and its byte length.
 */
function headByBytes(text: string, maxBytes: number): { text: string; bytes: number } {
  if (maxBytes <= 0) return { text: '', bytes: 0 };
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return { text: out, bytes };
}

/**
 * The longest UTF-8 suffix of `text` that fits in `maxBytes`, cut on a Unicode
 * code-point boundary. Built by walking code points from the end so a multi-byte
 * character is never split.
 */
function tailByBytes(text: string, maxBytes: number): { text: string; bytes: number } {
  if (maxBytes <= 0) return { text: '', bytes: 0 };
  const points = Array.from(text);
  let out = '';
  let bytes = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const chBytes = Buffer.byteLength(points[i], 'utf8');
    if (bytes + chBytes > maxBytes) break;
    out = points[i] + out;
    bytes += chBytes;
  }
  return { text: out, bytes };
}

/** Compose the notice line appended after the preview. */
function spillNotice(omittedBytes: number, locator: string): string {
  return `(${omittedBytes} bytes omitted. Full result stored at: ${locator}. ${RETRIEVAL_HINT})`;
}

/**
 * Build the bounded replacement: a head/tail preview whose combined size, plus
 * the notice, stays within `cap`. The notice cost is reserved first (priced at
 * the worst-case omission count so the real notice can only be shorter), then the
 * remaining budget is split across head and tail. Returns the replacement text
 * and how many bytes of the original were omitted.
 */
function buildReplacement(content: string, totalBytes: number, cap: number, locator: string): string {
  // Reserve the notice at the worst case: every byte omitted. Its digit count
  // bounds the real omission's, so the reservation is a safe upper bound and the
  // final notice is never longer than reserved. `+2` is the "\n\n" join.
  const reserve = Buffer.byteLength(spillNotice(totalBytes, locator), 'utf8') + 2;
  const previewBudget = Math.max(0, cap - reserve);
  const headBudget = Math.ceil(previewBudget / 2);
  const tailBudget = Math.floor(previewBudget / 2);
  const head = headByBytes(content, headBudget);
  const tail = tailByBytes(content, tailBudget);
  const previewBytes = head.bytes + tail.bytes;
  const omitted = totalBytes - previewBytes;
  const notice = spillNotice(omitted, locator);
  const preview = head.text + tail.text;
  return preview.length > 0 ? `${preview}\n\n${notice}` : notice;
}

/**
 * Spill `input.content` when it exceeds the inline cap, returning a bounded
 * preview + locator; otherwise report that it stays inline.
 *
 * Every failure mode is best-effort and reports `spilled: false`:
 *   - within the cap ⇒ nothing to do;
 *   - no session owner ⇒ cannot scope storage, keep inline;
 *   - the write fails ⇒ keep inline, surface the error for logging;
 *   - the bounded replacement would exceed the cap (a tiny cap, a long locator)
 *     ⇒ spilling would break the advertised cap, so keep inline (the written
 *     file is a harmless orphan).
 *
 * @param input - the session owner, tool name, and full content.
 * @param config - optional cap and root.
 * @returns the spill decision.
 */
export async function spillText(input: SpillTextInput, config: SpillTextConfig = {}): Promise<SpillTextResult> {
  const cap = config.maxInlineBytes ?? SPILL_DEFAULT_MAX_INLINE_BYTES;
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(`spillText: maxInlineBytes must be a non-negative integer (got ${cap})`);
  }

  const totalBytes = Buffer.byteLength(input.content, 'utf8');
  if (totalBytes <= cap) return { spilled: false };

  if (input.sessionId.length === 0) {
    return { spilled: false, error: 'no session owner; keeping inline content' };
  }

  const save: SaveTextOptions = {
    root: config.root ?? (await resolveDefaultRoot()),
    sessionId: input.sessionId,
    suggestedName: `${input.toolName}.txt`,
    content: input.content,
  };

  let saved: Awaited<ReturnType<typeof saveTextFile>>;
  try {
    saved = await saveTextFile(save);
  } catch (error: unknown) {
    return { spilled: false, error: error instanceof Error ? error.message : String(error) };
  }

  const replacedText = buildReplacement(input.content, totalBytes, cap, saved.path);
  // Never emit a replacement larger than the cap: for a tiny cap or a long
  // locator the notice alone can exceed it, in which case there is no within-cap
  // replacement and spilling would break the advertised cap.
  if (Buffer.byteLength(replacedText, 'utf8') > cap) {
    return { spilled: false, error: 'spill notice exceeds the inline cap; keeping inline content' };
  }

  return { spilled: true, text: replacedText, locator: saved.path, bytes: saved.bytes };
}

/** Resolve the private default root lazily, so importing this module has no I/O. */
async function resolveDefaultRoot(): Promise<string> {
  const { privateRoot } = await import('./store');
  return privateRoot();
}
