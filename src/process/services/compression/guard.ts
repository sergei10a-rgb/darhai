/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guard-and-restore for spans that MUST survive compression byte-for-byte:
 * fenced code blocks, inline code, URLs, and JSON-looking objects/arrays.
 *
 * Each protected span is lifted out of the text and replaced by an opaque
 * sentinel placeholder before any prose rule runs; after the rules finish the
 * placeholders are swapped back for the original spans verbatim. This is the
 * mechanism that lets the lossy prose rules touch ONLY prose - a filler word
 * inside a JSON string value or a code identifier is never altered.
 *
 * Placeholders use Unicode Private-Use-Area sentinels (U+E000 / U+E001) so they
 * cannot collide with real content, contain no whitespace, no ANSI, and no word
 * the filler rules match, and survive line-oriented transforms intact.
 */

const SENTINEL_OPEN = String.fromCharCode(0xe000);
const SENTINEL_CLOSE = String.fromCharCode(0xe001);

export interface GuardedText {
  /** Text with every protected span replaced by a placeholder. */
  masked: string;
  /** Original spans, indexed by placeholder number. */
  tokens: string[];
}

/** Build the opaque placeholder for a given token index. */
function placeholder(index: number): string {
  // The `G` keeps it a word-shaped token so line-noise heuristics never flag it.
  return `${SENTINEL_OPEN}G${index}${SENTINEL_CLOSE}`;
}

/** Replace every match of `regex` with a placeholder, recording the original. */
function maskByRegex(text: string, regex: RegExp, tokens: string[]): string {
  return text.replace(regex, (match) => {
    const token = placeholder(tokens.length);
    tokens.push(match);
    return token;
  });
}

/** Fenced code blocks: ```...``` or ~~~...~~~ (kept first so inner backticks/URLs are safe). */
const FENCED_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
/** Inline code: `...` on a single line. */
const INLINE_CODE = /`[^`\n]+`/g;
/** URLs: http(s):// or www. runs, up to the first whitespace/quote/bracket. */
const URL_SPAN = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi;

/**
 * Find the index of the delimiter that balances the `{`/`[` at `start`, honoring
 * double-quoted strings (so a `}` inside a string value never closes the group).
 * Returns -1 when the group is unbalanced.
 */
function findBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Mask top-level `{...}` / `[...]` groups that look like JSON (contain a quote
 * plus a `:` or `,`). Nested groups are captured as one unit. Prose braces such
 * as `{x}` with no quote are left untouched so the rules can still run around
 * them.
 */
function maskJsonLike(text: string, tokens: string[]): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      const end = findBalancedEnd(text, i);
      if (end > i) {
        const span = text.slice(i, end + 1);
        if (span.includes('"') && /[:,]/.test(span)) {
          const token = placeholder(tokens.length);
          tokens.push(span);
          out += token;
          i = end + 1;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Extract every protected span (fenced code, inline code, URL, JSON) into
 * placeholders. Order matters: fenced code first so backticks / URLs / braces
 * inside a block are never double-processed.
 */
export function protect(text: string): GuardedText {
  const tokens: string[] = [];
  let masked = maskByRegex(text, FENCED_CODE, tokens);
  masked = maskByRegex(masked, INLINE_CODE, tokens);
  masked = maskByRegex(masked, URL_SPAN, tokens);
  masked = maskJsonLike(masked, tokens);
  return { masked, tokens };
}

/** Swap every placeholder back for its original span (reverse order for safety). */
export function restore(masked: string, tokens: string[]): string {
  let out = masked;
  for (let i = tokens.length - 1; i >= 0; i--) {
    out = out.split(placeholder(i)).join(tokens[i]);
  }
  return out;
}
