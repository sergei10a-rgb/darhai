/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mongolian (Cyrillic) turns must surface relevant skills.
 *
 * This drives `buildTurnSkillContext` against the REAL bundled skills library
 * (all ~2.4k entries), not a fixture, because the defect only existed at that
 * scale: the library is written in English, so a Mongolian turn's Cyrillic
 * words cannot co-occur with its Latin loan word in any single skill. The
 * relevance gate demanded two shared query terms, which is unsatisfiable by
 * construction, so every Mongolian turn surfaced NOTHING - including
 * "Надад Kubernetes кластерт програм байршуулахад туслаач", where the corpus
 * contains a dozen directly relevant Kubernetes skills.
 *
 * The English fixtures in `buildTurnSkillContext.test.ts` cover the opposite
 * guarantee (a same-script turn with one incidental shared word stays silent).
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
      loadBody: vi.fn(async () => null),
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

describe('buildTurnSkillContext - Mongolian Cyrillic turns', () => {
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

  it('surfaces Kubernetes skills for a Mongolian deployment request', async () => {
    const ctx = await buildTurnSkillContext('Надад Kubernetes кластерт програм байршуулахад туслаач');
    const names = advertisedNames(ctx.advert);

    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.includes('kubernetes'))).toBe(true);
  });

  it('surfaces React skills for a Mongolian component question', async () => {
    const ctx = await buildTurnSkillContext('React компонент хэрхэн үүсгэх вэ?');
    const names = advertisedNames(ctx.advert);

    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.includes('react'))).toBe(true);
  });

  it('surfaces a Postgres skill for a Mongolian query-tuning request', async () => {
    const ctx = await buildTurnSkillContext('Postgres өгөгдлийн сангийн асуулгыг хурдасгахад тусална уу');

    expect(advertisedNames(ctx.advert)).toContain('postgres-expert');
  });

  it('stays silent on a Mongolian greeting', async () => {
    for (const greeting of ['Сайн байна уу?', 'Сайн уу, юу вэ?', 'Баярлалаа, за тэгье']) {
      const ctx = await buildTurnSkillContext(greeting);
      expect(ctx).toEqual({ advert: '', autoLoaded: [] });
    }
  });

  it('does not let Mongolian filler words drag in unrelated skills', async () => {
    // «дээр» (on), «хэрэгтэй» (needed), «ямар» (what kind of) appear in the
    // ~100 Cyrillic-described skills. Before they were stopworded, this turn
    // advertised build-a-garden and create-tabletop-rpg on those words alone.
    const ctx = await buildTurnSkillContext('Монгол хэл дээр вэб сайтын дизайн хийхэд ямар ур чадвар хэрэгтэй вэ?');
    const names = advertisedNames(ctx.advert);

    expect(names).not.toContain('build-a-garden');
    expect(names).not.toContain('create-tabletop-rpg');
  });

  it('treats precomposed and combining-breve spellings of the same word alike', async () => {
    // «й» = и + U+0306. Some editors and macOS filenames emit the NFD form.
    const precomposed = 'Kubernetes кластерийн тохиргоо';
    const decomposed = precomposed.normalize('NFD');
    expect(decomposed).not.toBe(precomposed);

    const a = await buildTurnSkillContext(precomposed);
    const b = await buildTurnSkillContext(decomposed);
    expect(advertisedNames(b.advert)).toEqual(advertisedNames(a.advert));
    expect(advertisedNames(a.advert).length).toBeGreaterThan(0);
  });
});
