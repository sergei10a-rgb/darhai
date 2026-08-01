/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Query-term extraction and the two predicates that decide whether the
 * cross-lingual relevance relaxation may fire.
 *
 * These are unit-level guards for the behaviour
 * `buildTurnSkillContextTransliterated.test.ts` measures end-to-end against the
 * real library - kept separate so a regression points at the mechanism rather
 * than at a ranking shift in a 2.4k-document corpus.
 */
import { describe, it, expect } from 'vitest';
import {
  discriminativeQueryTerms,
  hasCrossLingualBridgeTerm,
  isMongolianTurn,
  isMostlyNonLatinScript,
} from '@process/services/skills/skillQueryTerms';

describe('discriminativeQueryTerms', () => {
  it('canonicalizes Cyrillic transliterations into English retrieval terms', () => {
    const terms = discriminativeQueryTerms('надад пайтон юнит тэст бичхэд туслаач пайтэст ашиглаад');
    expect(terms).toContain('python');
    expect(terms).toContain('pytest');
    expect(terms).toContain('unit');
    expect(terms).toContain('test');
    // Replaced, not duplicated - a concept must not be able to score twice.
    expect(terms).not.toContain('пайтон');
    expect(terms).not.toContain('пайтэст');
  });

  it('canonicalizes Latin romanizations the same way', () => {
    const terms = discriminativeQueryTerms('nadad paiton yunit test bichhed tuslaach paitest ashiglaad');
    expect(terms).toContain('python');
    expect(terms).toContain('pytest');
    expect(terms).toContain('unit');
    expect(terms).toContain('test');
  });

  it('strips romanized Mongolian function words, like their Cyrillic twins', () => {
    const terms = discriminativeQueryTerms('nadad bichihed tuslaach ashiglaad heregtei baina yamar');
    expect(terms).toEqual([]);
  });

  it('leaves an English turn exactly as it was', () => {
    expect(discriminativeQueryTerms('help me write a python unit test with pytest fixtures')).toEqual([
      'help',
      'write',
      'python',
      'unit',
      'test',
      'pytest',
      'fixtures',
    ]);
  });
});

describe('isMongolianTurn', () => {
  it('detects Cyrillic', () => {
    const text = 'Надад Kubernetes кластерт програм байршуулахад туслаач';
    expect(isMongolianTurn(text, discriminativeQueryTerms(text))).toBe(true);
  });

  it('detects Mongolian written in Latin by its function words', () => {
    const text = 'nadad paiton yunit test bichhed tuslaach paitest ashiglaad';
    // Every content word canonicalized to English, so a script test alone sees
    // a pure-Latin turn - the romanized markers are what identify it.
    expect(isMostlyNonLatinScript(discriminativeQueryTerms(text))).toBe(false);
    expect(isMongolianTurn(text, discriminativeQueryTerms(text))).toBe(true);
  });

  it('does not claim an English turn is Mongolian', () => {
    const text = 'help me write a python unit test with pytest fixtures';
    expect(isMongolianTurn(text, discriminativeQueryTerms(text))).toBe(false);
  });
});

describe('hasCrossLingualBridgeTerm', () => {
  it('is true when the turn names a term the English corpus could contain', () => {
    expect(hasCrossLingualBridgeTerm(discriminativeQueryTerms('React компонент хэрхэн үүсгэх вэ?'))).toBe(true);
    // ...including one that only became Latin through canonicalization.
    expect(hasCrossLingualBridgeTerm(discriminativeQueryTerms('надад пайтон тэст бичхэд туслаач'))).toBe(true);
  });

  it('is false for Mongolian small talk with no technical term', () => {
    const text = 'Сайн байна уу, өнөөдөр цаг агаар ямар байна?';
    expect(hasCrossLingualBridgeTerm(discriminativeQueryTerms(text))).toBe(false);
  });
});
