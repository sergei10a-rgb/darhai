/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Personal-dictionary semantics, ported from mn-asr-app's `personal_dict.py`
 * where they were shipped and measured. The load-bearing properties:
 *
 *   - WHOLE WORD ONLY, bounded on BOTH sides: «коён» → «хоёр» must fire, and
 *     «коёнхон» must survive untouched. This is the difference from glossfix,
 *     whose keys are stems that deliberately keep their suffixes.
 *   - Case-insensitive over Cyrillic (JS `\b`/`\w` are ASCII-only, so the
 *     boundary is the explicit letter class glossfix uses - on both sides).
 *   - One pass, longest key first: a replacement is never re-scanned by a
 *     shorter rule, and a long key beats its own prefix.
 *   - Pure and never throws - bad input returns the text unchanged.
 */

import { describe, expect, it } from 'vitest';
import { applyPersonalDict } from '@process/services/voice/mongol/personalDict';

describe('applyPersonalDict', () => {
  it('replaces a whole word (the measured «коён» → «хоёр» case)', () => {
    expect(applyPersonalDict('коён цаг болсон', { коён: 'хоёр' })).toBe('хоёр цаг болсон');
  });

  it('never fires inside a longer word («коёнхон» keeps its bytes)', () => {
    // Whole-word means bounded on BOTH sides. A start-only guard (glossfix's)
    // would still rewrite the head of «коёнхон» - this is the assertion that
    // tells the two semantics apart.
    expect(applyPersonalDict('коёнхон ирлээ', { коён: 'хоёр' })).toBe('коёнхон ирлээ');
    // ...and bounded at the start: a key inside a longer word's tail stays.
    expect(applyPersonalDict('аркоён явлаа', { коён: 'хоёр' })).toBe('аркоён явлаа');
  });

  it('matches Cyrillic case-insensitively, including at sentence start', () => {
    expect(applyPersonalDict('Коён цаг', { коён: 'хоёр' })).toBe('хоёр цаг');
    expect(applyPersonalDict('КОЁН цаг', { коён: 'хоёр' })).toBe('хоёр цаг');
  });

  it('inserts the replacement verbatim (no case folding of the value)', () => {
    expect(applyPersonalDict('дархай гэдэг', { дархай: 'Дархай' })).toBe('Дархай гэдэг');
  });

  it('applies the longest source first so multi-word entries win over their parts', () => {
    const dict = { улаанбаатар: 'УБ', 'улаанбаатар хот': 'нийслэл' };
    expect(applyPersonalDict('улаанбаатар хот руу', dict)).toBe('нийслэл руу');
  });

  it('never re-scans a replacement with a shorter rule (single pass)', () => {
    // «Улаанбаатар» → «Улаанбаатар хот» must NOT then become «УБ» - the exact
    // trap personal_dict.py's combined-regex design exists to close.
    const dict = { улаанбаатар: 'Улаанбаатар хот', 'улаанбаатар хот': 'УБ' };
    expect(applyPersonalDict('улаанбаатар руу явна', dict)).toBe('Улаанбаатар хот руу явна');
  });

  it('replaces every occurrence, not just the first', () => {
    expect(applyPersonalDict('коён нэмэх коён', { коён: 'хоёр' })).toBe('хоёр нэмэх хоёр');
  });

  it('accepts a Map as well as a plain record', () => {
    expect(applyPersonalDict('коён цаг', new Map([['коён', 'хоёр']]))).toBe('хоёр цаг');
  });

  it('returns the text unchanged for an empty or missing dictionary', () => {
    expect(applyPersonalDict('коён цаг', {})).toBe('коён цаг');
    expect(applyPersonalDict('коён цаг', undefined)).toBe('коён цаг');
    expect(applyPersonalDict('коён цаг', null)).toBe('коён цаг');
  });

  it('ignores blank sources instead of building a match-everything pattern', () => {
    expect(applyPersonalDict('коён цаг', { '': 'юу ч биш', '  ': 'мөн адил', коён: 'хоёр' })).toBe('хоёр цаг');
  });

  it('escapes regex metacharacters in sources', () => {
    expect(applyPersonalDict('c++ сурна', { 'c++': 'C++' })).toBe('C++ сурна');
  });

  it('coerces a non-string replacement instead of crashing (str(dst) in the source impl)', () => {
    expect(applyPersonalDict('коён цаг', { коён: 123 as unknown as string })).toBe('123 цаг');
  });

  it('never throws on hostile input - the input comes back unchanged', () => {
    // The transcription result must not die on a malformed stored config.
    expect(applyPersonalDict(42 as unknown as string, { коён: 'хоёр' })).toBe(42 as unknown as string);
  });
});
