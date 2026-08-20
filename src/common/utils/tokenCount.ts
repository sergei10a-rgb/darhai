/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The single place where "how many tokens is this text?" is answered.
 *
 * Why this module exists
 * ----------------------
 * The repo used to answer that question with `Math.ceil(text.length / 4)`,
 * inlined in three separate places. That heuristic is roughly right for
 * English and badly wrong for Cyrillic. MEASURED on the shipped
 * `DEFAULT_CONSTITUTION` (7,185 chars, 5,180 of them non-ASCII):
 *
 *   counter        DEFAULT_CONSTITUTION (mn)   an ASCII control doc
 *   len/4                        1,797                       2,312
 *   o200k_base                   2,882  (1.60x)              2,331  (1.01x)
 *   cl100k_base                  5,411  (3.01x)              2,319  (1.00x)
 *
 * So a Mongolian user was shown a number ~38% below the truth, and the
 * "approaching the ceiling" warning fired far too late for them.
 *
 * `len/4` is not exact for English either - MEASURED drift against o200k on
 * three real samples: 0.8% (a structured control doc), 8.8% (repo-style
 * markdown), 28.8% (flowing prose, where it OVERcounts). It is simply much
 * closer there than on Cyrillic, and it errs in both directions rather than
 * systematically low.
 *
 * Why the number is still approximate
 * -----------------------------------
 * o200k_base is OpenAI's tokenizer. Claude and Gemini use their own, which are
 * not public. The table above shows that two real tokenizers can disagree by
 * 3.0x on the same Cyrillic text, so no single counter can be "the" count.
 * Every value produced here therefore carries the `counter` that produced it,
 * and the UI renders it with a "≈" and names the counter. o200k_base is the
 * pick because it is the modern, multilingual-efficient BPE - cl100k is the
 * legacy one whose Cyrillic cost is an outlier.
 */

/** Which counter produced a {@link TokenEstimate}. */
export type TokenCounterId = 'o200k_base' | 'chars-div-4';

/** Counts the tokens in `text`. */
export type TokenEncoder = (text: string) => number;

export type TokenEstimate = {
  /** The count. Always an approximation - see `counter`. */
  tokens: number;
  /** Which counter produced `tokens`. Never omit this when displaying it. */
  counter: TokenCounterId;
};

/** Short, user-facing name for each counter. Rendered next to the number. */
export const TOKEN_COUNTER_LABEL: Record<TokenCounterId, string> = {
  o200k_base: 'o200k',
  'chars-div-4': 'chars/4',
};

/**
 * English fallback copy for the tooltip that explains the "≈". Lives here, not
 * in a page, because both editors show the same number and must give the same
 * explanation. The i18n key is `settings.constitutionPage.tokenCountHint`.
 */
export const TOKEN_COUNTER_HINT =
  'Approximate. Counted with the OpenAI o200k_base tokenizer. Claude and Gemini use their own tokenizers, which are not public, so the real count differs - measured spread on Cyrillic text: 1.6x-3.0x between tokenizers.';

/**
 * Instruction-adherence ceiling, in real tokens.
 *
 * NOT re-derived here: these two numbers predate this module and nothing in
 * the repo measures model adherence against prompt length. What changed is the
 * measuring stick, not the ceiling - the UI has always claimed "~2,000
 * tokens", and the fix is to compare that claim against real tokens instead of
 * against `len/4` units.
 *
 * Consequence to be aware of, MEASURED: the shipped DEFAULT_CONSTITUTION is
 * 2,882 real tokens, so a fresh install now renders in the "warning" band
 * where it used to render green. Nothing about that document changed - only
 * the measurement did. Moving the threshold up so the default looks green
 * again would just relocate the original comfort-lie, so it is left alone and
 * flagged for the owner instead.
 */
export const TOKEN_WARNING_TOKENS = 2000;
export const TOKEN_ERROR_TOKENS = 3000;

export type TokenLevel = 'ok' | 'warning' | 'error';

export function tokenLevel(tokens: number): TokenLevel {
  if (tokens >= TOKEN_ERROR_TOKENS) return 'error';
  if (tokens >= TOKEN_WARNING_TOKENS) return 'warning';
  return 'ok';
}

/** The old heuristic. Kept only as the fallback when no encoder is available. */
export function charsDivFourTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Count `text` with `encode` when one is available, else fall back to the
 * character heuristic. The returned `counter` says which one ran, so a caller
 * can never present a fallback number as if it were a real token count.
 */
export function estimateTokens(text: string, encode?: TokenEncoder | null): TokenEstimate {
  if (encode) {
    try {
      return { tokens: encode(text), counter: 'o200k_base' };
    } catch (err) {
      console.error('[tokenCount] encoder threw; falling back to the char heuristic', err);
    }
  }
  return { tokens: charsDivFourTokens(text), counter: 'chars-div-4' };
}

/**
 * Lazily loaded o200k_base encoder.
 *
 * `gpt-tokenizer`'s o200k rank table is 2.4 MB of JavaScript and MEASURED
 * ~145 ms to require cold, so it is never on any startup path: the renderer
 * gets it as its own code-split chunk, and the main process pays for it on the
 * first prompt composition rather than at boot.
 */
let encoderPromise: Promise<TokenEncoder | null> | null = null;
let loadedEncoder: TokenEncoder | null = null;

export function loadTokenEncoder(): Promise<TokenEncoder | null> {
  encoderPromise ??= import('gpt-tokenizer/encoding/o200k_base')
    .then((mod) => {
      loadedEncoder = (text: string): number => mod.countTokens(text);
      return loadedEncoder;
    })
    .catch((err: unknown): TokenEncoder | null => {
      console.error('[tokenCount] failed to load the o200k_base tokenizer', err);
      return null;
    });
  return encoderPromise;
}

/**
 * The encoder if it has already finished loading, else `null`. Callers that
 * cannot await (synchronous composers) use this and get a labelled fallback
 * until the load completes.
 */
export function getLoadedTokenEncoder(): TokenEncoder | null {
  return loadedEncoder;
}
