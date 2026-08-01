/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transliterated Mongolian turns must surface the same skills as their English
 * original - in BOTH directions of transliteration.
 *
 * Driven against the REAL bundled library (~2.4k entries) because the defect
 * only exists at that scale. Measured before the fix, on one request written
 * five ways:
 *
 *   1. "help me write a python unit test with pytest fixtures"        -> found
 *   2. "Надад python unit test бичихэд туслаач pytest ашиглаад"       -> found
 *   3. "надад пайтон юнит тэст бичхэд туслаач пайтэст ашиглаад"       -> NOTHING
 *   4. "nadad python unit test bichihed tuslaach pytest ashiglaad"    -> found
 *   5. "nadad paiton yunit test bichhed tuslaach paitest ashiglaad"   -> NOTHING
 *
 * The rule: if even ONE real English technical term survived in Latin,
 * retrieval worked. Transliterate every term - in either direction - and the
 * turn became a dead end, because «пайтон» is simply not the string `python`.
 *
 * The last test is the other half of the contract: Mongolian small talk with no
 * technical content must still surface nothing. Before this change it
 * advertised three unrelated career skills, because the cross-lingual
 * relaxation fired unconditionally for any Cyrillic turn.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { SkillIndexEntry } from '@/common/types/skillTypes';

const { libState } = vi.hoisted(() => ({
  libState: { entries: [] as SkillIndexEntry[] },
}));

vi.mock('@process/services/skills/SkillLibrary', () => ({
  SkillLibrary: {
    getInstance: () => ({
      list: vi.fn(async () => libState.entries),
      loadBody: vi.fn(async (name: string) => `# ${name}\nbody`),
    }),
  },
}));

vi.mock('@process/utils/initStorage', () => ({
  getSkillsDir: () => '/mock/skills',
  getBuiltinSkillsCopyDir: () => '/mock/builtin-skills',
  loadSkillsContent: vi.fn().mockResolvedValue(''),
}));
vi.mock('@process/team/prompts/teamGuidePrompt.ts', () => ({
  getTeamGuidePrompt: vi.fn(() => 'TEAM_GUIDE'),
}));
vi.mock('@process/team/prompts/teamGuideAssistant.ts', () => ({
  resolveLeaderAssistantLabel: vi.fn().mockResolvedValue('Leader'),
}));

import { buildTurnSkillContext } from '@process/task/agentUtils';

const BUNDLED_INDEX = path.resolve(__dirname, '../../../../src/process/resources/skills-library/index.json');

/** Names listed in the "[Relevant skills for this request]" advert block. */
function advertisedNames(advert: string): string[] {
  return advert
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).split(':')[0].trim());
}

/** Every skill this turn surfaced, auto-loaded or advertised. */
async function surfaced(text: string): Promise<string[]> {
  const ctx = await buildTurnSkillContext(text);
  return [...ctx.autoLoaded.map((s) => s.name), ...advertisedNames(ctx.advert)];
}

/** The same "write me a pytest unit test" request, written five ways. */
const SPELLINGS: ReadonlyArray<readonly [label: string, text: string]> = [
  ['english', 'help me write a python unit test with pytest fixtures'],
  ['mongolian-cyrillic, terms in latin', 'Надад python unit test бичихэд туслаач pytest ашиглаад'],
  ['mongolian-cyrillic, terms transliterated', 'надад пайтон юнит тэст бичхэд туслаач пайтэст ашиглаад'],
  ['mongolian-latin, terms in latin', 'nadad python unit test bichihed tuslaach pytest ashiglaad'],
  ['mongolian-latin, terms transliterated', 'nadad paiton yunit test bichhed tuslaach paitest ashiglaad'],
];

describe('buildTurnSkillContext - transliterated technical terms', () => {
  beforeAll(() => {
    // The vendored index stores `tags` as a space-separated string; SkillLibrary
    // normalizes that on load, so mirror it here to feed the retriever the same
    // shape the running app does.
    const raw = JSON.parse(fs.readFileSync(BUNDLED_INDEX, 'utf-8')) as SkillIndexEntry[];
    libState.entries = raw.map((e) => {
      const tags: unknown = e.metadata?.tags;
      if (Array.isArray(tags)) return e;
      return {
        ...e,
        metadata: {
          ...e.metadata,
          tags: typeof tags === 'string' ? tags.split(/[\s,]+/).filter(Boolean) : [],
        },
      };
    });
    expect(libState.entries.length).toBeGreaterThan(1000);
  });

  it.each(SPELLINGS)('finds the Python testing skill for a request written in %s', async (_label, text) => {
    const names = await surfaced(text);
    expect(names).toContain('python-testing-patterns');
  });

  it('surfaces only Python/testing skills, never a grab-bag', async () => {
    for (const [, text] of SPELLINGS) {
      const names = await surfaced(text);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(name).toMatch(/python|test/);
      }
    }
  });

  it('finds Docker and Kubernetes skills from their Cyrillic spellings', async () => {
    expect(await surfaced('надад докер контейнер ашиглах тухай заавар хэрэгтэй')).toEqual(
      expect.arrayContaining([expect.stringContaining('docker')])
    );
    expect(await surfaced('кубернетес кластер дээр деплой хийх')).toEqual(
      expect.arrayContaining([expect.stringContaining('kubernetes')])
    );
  });

  it('stays silent on Mongolian small talk that names no technical term', async () => {
    // The precision half of the contract. This turn has content words
    // («өнөөдөр», «цаг», «агаар») but no term the English corpus knows, so the
    // cross-lingual relaxation must NOT fire and its single incidental
    // Cyrillic match must not be promoted into an advert.
    for (const chatty of [
      'Сайн байна уу, өнөөдөр цаг агаар ямар байна?',
      'Өнөөдөр цаг агаар сайхан байна шүү',
      'Маргааш уулзалт хэдэн цагт болох вэ',
    ]) {
      const ctx = await buildTurnSkillContext(chatty);
      expect(ctx).toEqual({ advert: '', autoLoaded: [] });
    }
  });

  it('keeps an English turn silent when its only match is incidental', async () => {
    // Unchanged guarantee: same-script turns still owe two shared terms, so the
    // transliteration work cannot have re-opened the "5 skills on every
    // message" hole from the English side either.
    const ctx = await buildTurnSkillContext('zzzqqq wibble frobnicate quuxly');
    expect(ctx).toEqual({ advert: '', autoLoaded: [] });
  });
});
