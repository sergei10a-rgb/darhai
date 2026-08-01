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
 *   - Transliterated technical terms match their English form in BOTH
 *     directions: a note that says «пайтон» is found by `python`, and a note
 *     that says `python` is found by «пайтон». This is the same defect the
 *     skill retriever had, and it bites harder here because the matcher is a
 *     strict AND - one unmatched token drops the entry entirely. Both sides are
 *     canonicalized (query AND entry) because both sides are written by the
 *     SAME user, who has no reason to spell a term the same way in a note as in
 *     a search box months later. The rule is purely ADDITIVE: the raw substring
 *     test still runs first, so no entry that matches today can stop matching.
 */

import { canonicalTechnicalTerm, isTransliteratedTechnicalTerm } from '@/common/utils/mongolianTechnicalTerms';

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

/** Unicode-aware word run - the unit an alias lookup is defined on. */
const WORD_RE = /[\p{L}\p{N}_-]+/gu;

/**
 * The canonical English form of a query token, or `null` when the token is not
 * a known transliteration. Punctuation is trimmed first, because
 * {@link queryTokens} splits on whitespace only, so a user typing «пайтон,»
 * would otherwise miss the table.
 */
function canonicalFormOf(token: string): string | null {
  const bare = token.match(/[\p{L}\p{N}_-]+/u)?.[0];
  if (bare === undefined || !isTransliteratedTechnicalTerm(bare)) return null;
  return canonicalTechnicalTerm(bare);
}

/**
 * The text one entry is searched over: summary, body preview and tags, plus the
 * canonical English form of any transliterated technical term found in them.
 *
 * The canonical forms are APPENDED rather than substituted, so the original
 * spelling stays searchable and the substring semantics of every existing query
 * are untouched.
 */
function haystack(entry: SearchableEntry): string {
  const text = normalizeSearchText([entry.summary, entry.bodyPreview, ...entry.tags].join('\n'));
  const canonical = new Set<string>();
  for (const word of text.match(WORD_RE) ?? []) {
    if (isTransliteratedTechnicalTerm(word)) canonical.add(canonicalTechnicalTerm(word));
  }
  return canonical.size === 0 ? text : `${text}\n${[...canonical].join(' ')}`;
}

/**
 * True when every token of `query` occurs somewhere in the entry, either as
 * written or as its canonical English form. An empty or whitespace-only query
 * matches nothing (callers skip search entirely instead).
 */
export function matchesQuery(entry: SearchableEntry, query: string): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return false;
  const text = haystack(entry);
  return tokens.every((token) => {
    if (text.includes(token)) return true;
    const canonical = canonicalFormOf(token);
    return canonical !== null && text.includes(canonical);
  });
}
