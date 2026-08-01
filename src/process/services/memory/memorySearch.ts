/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lexical matching for memory search.
 *
 * This is deliberately the ONLY thing that decides whether an entry is in a
 * search result. A vector lane used to union its hits into this result set, and
 * because `multilingual-e5-small` scores an unrelated query against an
 * unrelated passage in the same 0.79-0.83 band as a correct match (measured on
 * this corpus: the gibberish query `zzzqqqxyzzy` scored 0.8254 while the
 * correct hit for `Electron` scored 0.8426), no score threshold can separate
 * signal from noise - so every query, gibberish included, returned the whole
 * corpus. Membership is lexical; see fusion.ts for where vector hits are still
 * used (skill advertisement, where BM25 supplies the baseline and additions are
 * capped).
 *
 * Mongolian-first details that matter here:
 *   - Unicode NFC normalization, so `й`/`ё` written as base + combining breve
 *     (NFD, which some editors and macOS filenames produce) matches the same
 *     text written pre-composed.
 *   - Case folding via `toLowerCase`, which maps Ө→ө and Ү→ү correctly.
 *   - Whitespace-separated tokens must ALL appear, but may appear in different
 *     fields, so `Дархай санах ой` still finds an entry whose summary carries
 *     one half of the phrase and whose body carries the other.
 */

/** Fields a search runs over. Keeps this module decoupled from MemoryEntry. */
export type SearchableEntry = {
  summary: string;
  bodyPreview: string;
  tags: readonly string[];
};

/** Case-fold and NFC-normalize so Cyrillic compares by character, not by encoding. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

/** Split a raw query into the tokens that must all be present. */
export function queryTokens(query: string): string[] {
  return normalizeSearchText(query)
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** The text one entry is searched over: summary, body preview and tags. */
function haystack(entry: SearchableEntry): string {
  return normalizeSearchText([entry.summary, entry.bodyPreview, ...entry.tags].join('\n'));
}

/**
 * True when every token of `query` occurs somewhere in the entry. An empty or
 * whitespace-only query matches nothing (callers skip search entirely instead).
 */
export function matchesQuery(entry: SearchableEntry, query: string): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return false;
  const text = haystack(entry);
  return tokens.every((token) => text.includes(token));
}
