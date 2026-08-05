/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Context window size configuration for known models.
 *
 * Exported so `modelContextLimits.test.ts` can hold the Claude rows against
 * `resources/modelsdev-snapshot.json` - the table is hand-maintained, and the
 * whole point of the bug it replaced is that hand-maintained tables drift.
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Gemini family
  'gemini-3.1-pro-preview': 1_048_576,
  'gemini-3-pro-preview': 1_048_576,
  'gemini-3-flash-preview': 1_048_576,
  'gemini-3-pro-image-preview': 65_536,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
  'gemini-2.5-flash-image': 32_768,
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.0-flash-lite': 1_048_576,
  'gemini-1.5-pro': 2_097_152,
  'gemini-1.5-flash': 1_048_576,

  // OpenAI family
  'gpt-5.1': 400_000,
  'gpt-5.1-chat': 128_000,
  'gpt-5': 400_000,
  'gpt-5-chat': 128_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4-turbo-preview': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  'gpt-3.5-turbo-16k': 16_385,
  o1: 200_000,
  'o1-preview': 128_000,
  'o1-mini': 128_000,
  o3: 200_000,
  'o3-mini': 200_000,

  // Claude family. Keys are the REAL hyphenated catalog ids the app passes here.
  // They used to be dotted (`claude-opus-4.5`), which no real id ever matches, so
  // every Claude model fell through to the bare `claude-opus-4` / `claude-sonnet-4`
  // fuzzy prefixes: `claude-opus-4-8` (a 1M model) resolved to 200K and
  // `claude-sonnet-4-5` (a 200K model) resolved to 1M. That is not cosmetic - the
  // meter denominator and the compaction trigger both read this number, so a wrong
  // window either compacts far too early or lets a turn overflow the real one.
  //
  // Values come from our own `resources/modelsdev-snapshot.json`, and
  // `modelContextLimits.test.ts` re-checks every key against that snapshot so this
  // table cannot drift away from it again.
  //
  // The bare `claude-opus-4` / `-sonnet-4` / `-haiku-4` entries are the fuzzy
  // fallback for dated ids (`claude-opus-4-20250514`); longest-match means the
  // versioned keys above win wherever one exists.
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  // 200K, NOT the 1M some catalogs report. Sonnet 4.5's million-token window is
  // a beta tier that requires an `anthropic-beta: context-1m-*` request header,
  // and we never send one - so 1M is a window this app cannot actually obtain.
  // Claiming it would push compaction past the real ceiling and fail the turn.
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-haiku-4': 200_000,
  'claude-fable-5': 1_000_000,
  'claude-3-7-sonnet': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,
};

/**
 * Default context limit (used when the model cannot be determined)
 */
export const DEFAULT_CONTEXT_LIMIT = 1_048_576;

/**
 * Get context limit by model name
 * Supports fuzzy matching, e.g. "gemini-2.5-pro-latest" matches "gemini-2.5-pro"
 */
export function getModelContextLimit(modelName: string | undefined | null): number {
  if (!modelName) return DEFAULT_CONTEXT_LIMIT;

  const lowerModelName = modelName.toLowerCase();

  // Exact match
  if (MODEL_CONTEXT_LIMITS[lowerModelName]) {
    return MODEL_CONTEXT_LIMITS[lowerModelName];
  }

  // Fuzzy match: find the longest matching model name
  let bestMatch = '';
  let bestLimit = DEFAULT_CONTEXT_LIMIT;

  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (lowerModelName.includes(key) && key.length > bestMatch.length) {
      bestMatch = key;
      bestLimit = limit;
    }
  }

  return bestLimit;
}
