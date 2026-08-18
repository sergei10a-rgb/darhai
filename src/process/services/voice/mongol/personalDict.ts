/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Personal correction dictionary over Nemotron STT output: recurring
 * mistranscriptions the user cares about (names, company terms) fixed by a
 * small user-defined wrong → right map from `tools.speechToText.personalDict`.
 *
 * Ported from mn-asr-app `core/personal_dict.py`, keeping its semantics
 * exactly:
 *   - WHOLE WORD only, bounded on BOTH sides: «коён» → «хоёр» fires, and
 *     «коёнхон» is never touched. This differs from glossfix, whose keys are
 *     STEMS that deliberately keep their Mongolian suffixes - a personal
 *     entry is a literal word, so a start-only boundary would corrupt longer
 *     words that merely begin with it.
 *   - Case-insensitive; the replacement is inserted verbatim.
 *   - ONE pass via a combined regex (longest source first in the alternation)
 *     so a replacement is never re-scanned by a shorter rule: «Улаанбаатар
 *     хот» must not then be turned into «УБ хот».
 *   - Pure and never throws - any unexpected input returns the text unchanged.
 *
 * JS `\b`/`\w` are ASCII-only, so the boundary is the explicit letter class
 * glossfix.ts uses (its WORD_START), mirrored here on both sides.
 */

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** No letter or digit immediately before the word (glossfix's WORD_START). */
const WORD_START = '(?<![0-9A-Za-zА-Яа-яЁёӨҮөү])';

/** ...and none immediately after: the mirrored guard whole words need. */
const WORD_END = '(?![0-9A-Za-zА-Яа-яЁёӨҮөү])';

export type PersonalDictMapping = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

/**
 * Replace each `src` with `dst` (whole-word, case-insensitive). Never throws -
 * returns `text` unchanged on any error or bad input.
 */
export function applyPersonalDict(text: string, mapping: PersonalDictMapping | null | undefined): string {
  if (typeof text !== 'string' || !mapping) return text;
  try {
    const pairs = mapping instanceof Map ? [...mapping.entries()] : Object.entries(mapping);
    const lookup = new Map<string, string>();
    for (const [src, dst] of pairs) {
      const key = String(src);
      if (key.trim().length > 0) lookup.set(key.toLowerCase(), String(dst));
    }
    if (lookup.size === 0) return text;
    // Longest source first, so multi-word entries win over their parts.
    const sources = [...lookup.keys()].toSorted((a, b) => b.length - a.length);
    const pattern = new RegExp(`${WORD_START}(${sources.map(escapeRegExp).join('|')})${WORD_END}`, 'giu');
    return text.replace(pattern, (match) => lookup.get(match.toLowerCase()) ?? match);
  } catch {
    return text;
  }
}
