/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Caveman - remove verbose prose filler and wordy phrasings from natural-language
 * text while leaving technical content untouched.
 *
 * Every run first GUARDS the four span types that must never be altered - fenced
 * code blocks, inline code, URLs, and JSON-looking objects/arrays - by lifting
 * them out to opaque placeholders (see `guard.ts`). The ordered rewrite rules
 * then run on the remaining prose only, and the placeholders are restored
 * verbatim. Pure, deterministic, and idempotent: re-running on already-compressed
 * text is a no-op.
 *
 * Two strengths:
 *   - `cavemanModerate` - a conservative, high-confidence subset (balanced mode).
 *   - `caveman`         - the full filler set (aggressive mode).
 */

import { protect, restore } from './guard';

type CavemanLevel = 'moderate' | 'full';

interface Rule {
  pattern: RegExp;
  replacement: string;
}

/**
 * Conservative, high-confidence rewrites. These either map a wordy phrase to a
 * shorter exact synonym or drop unambiguous filler, and are extremely unlikely
 * to change the meaning of a sentence.
 */
const MODERATE_RULES: Rule[] = [
  { pattern: /\bin order to\b/gi, replacement: 'to' },
  { pattern: /\bin order for\b/gi, replacement: 'for' },
  { pattern: /\bdue to the fact that\b/gi, replacement: 'because' },
  { pattern: /\bfor the reason that\b/gi, replacement: 'because' },
  { pattern: /\bin the event that\b/gi, replacement: 'if' },
  { pattern: /\bin spite of the fact that\b/gi, replacement: 'although' },
  { pattern: /\bat this (?:point in time|moment in time)\b/gi, replacement: 'now' },
  { pattern: /\ba large number of\b/gi, replacement: 'many' },
  { pattern: /\bthe majority of\b/gi, replacement: 'most' },
  { pattern: /\bin the process of\b/gi, replacement: '' },
  { pattern: /\bit is worth noting that\b/gi, replacement: '' },
  { pattern: /\bit should be noted that\b/gi, replacement: '' },
  { pattern: /\bplease note that\b/gi, replacement: '' },
  // Standalone politeness / low-signal hedges (trailing space consumed).
  { pattern: /\b(?:please|kindly|basically|essentially)\b[ \t]*/gi, replacement: '' },
];

/**
 * Additional, more aggressive filler removal layered on top of MODERATE_RULES
 * for aggressive mode. Still prose-only (code/URLs/JSON are guarded).
 */
const AGGRESSIVE_RULES: Rule[] = [
  { pattern: /\bas you can see\b/gi, replacement: '' },
  { pattern: /\bas (?:mentioned|noted) (?:earlier|above|before|previously)\b/gi, replacement: '' },
  { pattern: /\bneedless to say\b/gi, replacement: '' },
  { pattern: /\bthat is to say\b/gi, replacement: '' },
  { pattern: /\bat the end of the day\b/gi, replacement: '' },
  { pattern: /\bwhen all is said and done\b/gi, replacement: '' },
  { pattern: /\bfor all intents and purposes\b/gi, replacement: '' },
  // Standalone intensifiers / hedges that add no information.
  {
    pattern:
      /\b(?:actually|really|very|quite|simply|just|literally|definitely|certainly|obviously|clearly|essentially|basically)\b[ \t]*/gi,
    replacement: '',
  },
];

/**
 * Tidy whitespace left behind by deletions, per line, while preserving leading
 * indentation (list/quote structure) and never collapsing whitespace inside a
 * placeholder. Idempotent.
 */
function tidy(text: string): string {
  const cleaned = text
    .split('\n')
    .map((line) => {
      const match = /^([ \t]*)([\s\S]*)$/.exec(line);
      const indent = match ? match[1] : '';
      let rest = match ? match[2] : line;
      rest = rest.replace(/[ \t]{2,}/g, ' '); // collapse internal runs of spaces/tabs
      rest = rest.replace(/[ \t]+([,.;:!?)])/g, '$1'); // drop space before punctuation
      rest = rest.replace(/([([])[ \t]+/g, '$1'); // drop space after an opening bracket
      rest = rest.replace(/[ \t]+$/g, ''); // trailing whitespace
      return indent + rest;
    })
    .join('\n');
  return cleaned.replace(/\n{3,}/g, '\n\n');
}

/**
 * Apply the ordered filler rules to ALREADY-MASKED prose (placeholders in place).
 * Exposed so `compress` can run RTK and the caveman rules under a single shared
 * guard pass without re-protecting.
 */
export function applyCavemanRules(masked: string, level: CavemanLevel): string {
  const rules = level === 'full' ? [...MODERATE_RULES, ...AGGRESSIVE_RULES] : MODERATE_RULES;
  let out = masked;
  for (const rule of rules) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return tidy(out);
}

/** Full filler removal (aggressive). Guards code/URLs/JSON, then restores them. */
export function caveman(text: string): string {
  const { masked, tokens } = protect(text);
  return restore(applyCavemanRules(masked, 'full'), tokens);
}

/** Conservative filler removal (balanced). Guards code/URLs/JSON, then restores them. */
export function cavemanModerate(text: string): string {
  const { masked, tokens } = protect(text);
  return restore(applyCavemanRules(masked, 'moderate'), tokens);
}
