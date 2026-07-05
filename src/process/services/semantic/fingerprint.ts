/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure fingerprint helper. A document's fingerprint is a hash of the text that
 * was embedded, plus the embedding model id and dimension. Re-embedding is
 * skipped when the stored fingerprint matches - so an unchanged corpus costs
 * zero inference on every startup, and a model swap forces a full re-embed
 * (mixing dimensions in one vec0 table would corrupt search).
 */

import { createHash } from 'node:crypto';

/**
 * Compute a stable fingerprint for a document's embedding.
 *
 * @param text  the exact text that was (or will be) embedded
 * @param model the embedding model id (so a model change invalidates old rows)
 * @param dim   the embedding dimension (defensive - dimension change ⇒ re-embed)
 */
export function computeFingerprint(text: string, model: string, dim: number): string {
  // Length-prefix EVERY variable-length field so no boundary shift between text
  // and model can collide (e.g. ('ab','m') vs ('a','bm')). `dim` is numeric, so
  // it needs no prefix. SHA-256 (over SHA-1) removes any collision-resistance
  // concern at no meaningful cost for these short payloads.
  const payload = `${text.length}:${text}|${model.length}:${model}|${dim}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
