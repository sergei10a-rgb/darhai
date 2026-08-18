/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Normalizers for the keyless wcore-session replay gate.
 *
 * The gate replays a recorded engine session (a committed JSONL of real
 * `WCoreEvent` frames, captured with no API key — see
 * `tests/fixtures/engine-contract/desktop/v1/observed/README.md`) through the
 * REAL decoder and byte-pins the frames the decoder emits. Byte-pinning a live
 * transcript only works once the few volatile spellings are turned into stable
 * tokens, exactly as the deepseek-harness ACP snapshot suite tokenizes JSON-RPC
 * ids and zeroes clocks before it diffs. These are the wcore analogue:
 *
 *  - `msg_id`: the engine assigns per-turn ids the host echoes verbatim. Their
 *    VALUE is an accident of the capture; their IDENTITY (same id ⇒ same turn)
 *    is the contract. First-seen order → `{{msg1}}`, `{{msg2}}`, … so a
 *    re-capture with different literal ids still diffs clean, while a decoder
 *    that crossed two turns' ids still fails. Empty string and `null` are
 *    semantic ("no active turn") and pass through unchanged.
 *  - clock spellings inside `data`: any ISO-8601 timestamp or 13-digit epoch-ms
 *    becomes `{{ts}}`. No session in the current corpus carries one through the
 *    decoder (measured), so this changes nothing today; it is the guard that
 *    keeps a future recorder that DOES surface a clock from silently drifting
 *    the golden every run.
 *
 * Nothing else is scrubbed. Digests (`sha256:…`), capability ids, reasons and
 * outputs come from the committed fixture and are therefore already stable —
 * scrubbing them would blind the gate to a decoder that mangles them.
 */

import { createHash } from 'node:crypto';

/** The decoder's output frame shape (`WCoreAgent.onStreamEvent`). */
export type StreamEvent = { type: string; data: unknown; msg_id: string };

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EPOCH_MS = /^\d{13}$/;

/** Replace clock spellings anywhere inside a decoded payload with `{{ts}}`. */
function scrubClocks(value: unknown): unknown {
  if (typeof value === 'string') {
    return ISO_8601.test(value) || EPOCH_MS.test(value) ? '{{ts}}' : value;
  }
  if (typeof value === 'number') {
    // 13-digit integers are epoch-ms; smaller counts (tokens, sequences) are not.
    return Number.isInteger(value) && value >= 1_000_000_000_000 && value < 10_000_000_000_000 ? '{{ts}}' : value;
  }
  if (Array.isArray(value)) return value.map(scrubClocks);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubClocks(v);
    return out;
  }
  return value;
}

/**
 * Turn a replayed frame stream into a stable, byte-comparable string.
 *
 * Object keys are emitted in a fixed (sorted) order so a V8 insertion-order
 * change cannot churn the golden, and the volatile spellings above are
 * tokenized. The result is deterministic for a deterministic decoder — the
 * property the gate exists to hold.
 */
export function normalizeReplay(frames: readonly StreamEvent[]): string {
  const msgIds = new Map<string, string>();
  let counter = 0;
  const tokenizeMsgId = (id: string): string => {
    if (id === '' || id === null || id === undefined) return id;
    const existing = msgIds.get(id);
    if (existing) return existing;
    const token = `{{msg${(counter += 1)}}}`;
    msgIds.set(id, token);
    return token;
  };

  const normalized = frames.map((frame) => ({
    type: frame.type,
    msg_id: tokenizeMsgId(frame.msg_id),
    data: scrubClocks(frame.data),
  }));

  return stableStringify(normalized) + '\n';
}

/** JSON with object keys sorted at every depth. Arrays keep their order. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Byte-level fingerprint of a normalized transcript. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}
