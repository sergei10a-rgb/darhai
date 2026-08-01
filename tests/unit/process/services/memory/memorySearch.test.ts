/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { matchesQuery, normalizeSearchText, queryTokens } from '@process/services/memory/memorySearch';

const entry = (summary: string, bodyPreview = '', tags: string[] = []) => ({ summary, bodyPreview, tags });

describe('normalizeSearchText', () => {
  it('case-folds Mongolian Cyrillic Ө and Ү', () => {
    expect(normalizeSearchText('ӨӨРИЙН ҮГ')).toBe('өөрийн үг');
  });

  it('normalizes decomposed Cyrillic breve to the composed form', () => {
    const decomposed = 'бай'.normalize('NFD');
    expect(normalizeSearchText(decomposed)).toBe('бай');
  });
});

describe('queryTokens', () => {
  it('splits on whitespace and drops empties', () => {
    expect(queryTokens('  Дархай   санах ой ')).toEqual(['дархай', 'санах', 'ой']);
  });

  it('returns no tokens for a blank query', () => {
    expect(queryTokens('   ')).toEqual([]);
  });
});

describe('matchesQuery', () => {
  it('finds a Cyrillic entry from a Cyrillic query regardless of case', () => {
    const e = entry('Дархай апп нь бүх интерфэйсээ монгол кирилл үсгээр харуулна');
    expect(matchesQuery(e, 'дархай')).toBe(true);
    expect(matchesQuery(e, 'КИРИЛЛ')).toBe(true);
  });

  it('finds a Latin entry from a Latin query', () => {
    expect(matchesQuery(entry('Electron IPC bridge uses the subscribe protocol'), 'Electron')).toBe(true);
  });

  it('does not match a gibberish query', () => {
    const corpus = [
      entry('Дархай апп нь монгол кирилл үсгээр харуулна'),
      entry('Electron IPC bridge uses the subscribe protocol'),
      entry('TELD charger protocol is not OCPP compliant', '', ['teld']),
    ];
    for (const e of corpus) {
      expect(matchesQuery(e, 'zzzqqqxyzzy')).toBe(false);
      expect(matchesQuery(e, 'qwrtplkjhgfdsazxcv')).toBe(false);
      expect(matchesQuery(e, 'ббббвввггг')).toBe(false);
    }
  });

  it('requires every token, so an unrelated extra token excludes the entry', () => {
    const e = entry('Дархай апп нь монгол кирилл үсгээр харуулна');
    expect(matchesQuery(e, 'Дархай монгол')).toBe(true);
    expect(matchesQuery(e, 'Дархай zzzqqqxyzzy')).toBe(false);
  });

  it('lets tokens come from different fields of the same entry', () => {
    const e = entry('Дархай апп', 'санах ойн шалгалт', ['монгол']);
    expect(matchesQuery(e, 'Дархай шалгалт монгол')).toBe(true);
  });

  it('matches tags', () => {
    expect(matchesQuery(entry('Something', '', ['монгол']), 'монгол')).toBe(true);
  });

  it('matches nothing for a blank query', () => {
    expect(matchesQuery(entry('anything'), '   ')).toBe(false);
  });
});
