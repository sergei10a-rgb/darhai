/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Invariants of the transliterated-technical-term table.
 *
 * The table buys recall for Mongolian users at the cost of a maintenance
 * surface, so the properties that keep it SAFE are asserted mechanically rather
 * than trusted: canonicalization must be idempotent, must never fire on English
 * text, and must never rewrite one technical term into a different one.
 */
import { describe, it, expect } from 'vitest';
import {
  TECHNICAL_TERM_ALIASES,
  canonicalTechnicalTerm,
  isTransliteratedTechnicalTerm,
} from '@/common/utils/mongolianTechnicalTerms';

describe('mongolianTechnicalTerms', () => {
  it('maps Cyrillic transliterations to their English term', () => {
    expect(canonicalTechnicalTerm('пайтон')).toBe('python');
    expect(canonicalTechnicalTerm('пайтэст')).toBe('pytest');
    expect(canonicalTechnicalTerm('докер')).toBe('docker');
    expect(canonicalTechnicalTerm('кубернетес')).toBe('kubernetes');
    expect(canonicalTechnicalTerm('реакт')).toBe('react');
    expect(canonicalTechnicalTerm('тайпскрипт')).toBe('typescript');
    expect(canonicalTechnicalTerm('гит')).toBe('git');
    expect(canonicalTechnicalTerm('юнит')).toBe('unit');
    expect(canonicalTechnicalTerm('тэст')).toBe('test');
  });

  it('maps Latin romanizations to the same English term', () => {
    expect(canonicalTechnicalTerm('paiton')).toBe('python');
    expect(canonicalTechnicalTerm('paitest')).toBe('pytest');
    expect(canonicalTechnicalTerm('doker')).toBe('docker');
    expect(canonicalTechnicalTerm('kubernetis')).toBe('kubernetes');
    expect(canonicalTechnicalTerm('yunit')).toBe('unit');
  });

  it('is case-insensitive and NFC-insensitive', () => {
    expect(canonicalTechnicalTerm('ПАЙТОН')).toBe('python');
    // «й» written as и + U+0306, the form some editors and macOS filenames emit.
    expect(canonicalTechnicalTerm('дизайн'.normalize('NFD'))).toBe('design');
  });

  it('leaves unknown tokens untouched', () => {
    for (const token of ['кластер', 'harness', 'zzzqqq', 'байршуулах']) {
      expect(canonicalTechnicalTerm(token)).toBe(token);
    }
  });

  it('is idempotent - no alias is itself a canonical term', () => {
    for (const [alias, canonical] of TECHNICAL_TERM_ALIASES) {
      expect(canonicalTechnicalTerm(alias)).toBe(canonical);
      expect(canonicalTechnicalTerm(canonical)).toBe(canonical);
      expect(isTransliteratedTechnicalTerm(canonical)).toBe(false);
    }
  });

  it('never rewrites ordinary English words', () => {
    // The precision guarantee: an English turn must canonicalize to itself, so
    // the table can only ever ADD Mongolian recall, never perturb English.
    const english = [
      'python',
      'pytest',
      'unit',
      'test',
      'testing',
      'docker',
      'kubernetes',
      'react',
      'git',
      'code',
      'web',
      'site',
      'design',
      'class',
      'object',
      'array',
      'model',
      'file',
      'cache',
      'build',
      'deploy',
      'debug',
      'deer',
      'door',
      'end',
      'tend',
      'hen',
      'mash',
      'bid',
      'bur',
      'piton',
      'help',
      'write',
      'fixtures',
    ];
    for (const word of english) {
      expect(canonicalTechnicalTerm(word)).toBe(word);
    }
  });
});
