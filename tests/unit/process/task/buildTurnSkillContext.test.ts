/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for buildTurnSkillContext - the per-turn skill auto-load helper
 * that proactively ranks the full skill library (BM25) against the current
 * user message, builds a top-5 advert, and inline-injects the single
 * high-confidence winner's body.
 *
 * The real SkillRetriever (BM25) is used; only SkillLibrary I/O is mocked so
 * the ranking + auto-load thresholds are exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SkillIndexEntry } from '@/common/types/skillTypes';

const { libState } = vi.hoisted(() => ({
  libState: {
    entries: [] as SkillIndexEntry[],
    bodies: {} as Record<string, string>,
  },
}));

// Mock SkillLibrary to serve our fixtures + bodies (no disk, no electron paths).
vi.mock('@process/services/skills/SkillLibrary', () => ({
  SkillLibrary: {
    getInstance: () => ({
      list: vi.fn(async () => libState.entries),
      loadBody: vi.fn(async (name: string) => libState.bodies[name] ?? null),
    }),
  },
}));

// Keep heavy transitive imports cheap/inert.
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

import { buildTurnSkillContext, isAutoLoadWinner } from '@process/task/agentUtils';

const entry = (overrides: Partial<SkillIndexEntry> & { name: string }): SkillIndexEntry => {
  const { metadata, ...rest } = overrides;
  return {
    description: '',
    type: 'skill',
    source: 'wayland-library',
    path: `bodies/${overrides.name}.md`,
    ...rest,
    metadata: { tags: [], category: 'dev', ...metadata },
  };
};

const FIXTURES: SkillIndexEntry[] = [
  entry({
    name: 'stripe-webhook-signing',
    description: 'Verify Stripe webhook signature payloads and handle signing secrets',
    metadata: { tags: ['stripe', 'webhook', 'signature', 'verification'], category: 'payments' },
  }),
  entry({
    name: 'react-component',
    description: 'Generate a React functional component',
    metadata: { tags: ['react', 'frontend'], category: 'frontend' },
  }),
  entry({
    name: 'kube-deploy',
    description: 'Deploy an application to a Kubernetes cluster',
    metadata: { tags: ['kubernetes', 'devops'], category: 'devops' },
  }),
  entry({
    name: 'sql-query',
    description: 'Write optimized SQL queries',
    metadata: { tags: ['sql', 'database'], category: 'database' },
  }),
  entry({
    name: 'git-rebase',
    description: 'Recover from a botched git rebase',
    metadata: { tags: ['git', 'version-control'], category: 'software-engineering' },
  }),
];

describe('buildTurnSkillContext', () => {
  beforeEach(() => {
    libState.entries = FIXTURES;
    libState.bodies = {
      'stripe-webhook-signing': '# Stripe Webhook Signing\nUse the signing secret to verify the signature header.',
    };
  });

  it('auto-loads the single high-confidence winner and excludes it from the advert', async () => {
    const ctx = await buildTurnSkillContext('how do I verify a stripe webhook signature');
    expect(ctx.autoLoaded.map((s) => s.name)).toEqual(['stripe-webhook-signing']);
    // Body is injected inline...
    expect(ctx.advert).toContain('[Auto-loaded skill: stripe-webhook-signing]');
    expect(ctx.advert).toContain('verify the signature header');
    // ...and the winner is NOT repeated in the "relevant skills" advert list.
    const advertListPart = ctx.advert.split('[Auto-loaded skill:')[0];
    expect(advertListPart).not.toContain('- stripe-webhook-signing:');
  });

  it('returns empty for a too-short query', async () => {
    const ctx = await buildTurnSkillContext('hi');
    expect(ctx).toEqual({ advert: '', autoLoaded: [] });
  });

  it('stays silent on greetings / conversational filler (below min content terms)', async () => {
    // Stopwords stripped: "hello/there/thanks/so/much" leave < 2 content terms,
    // so a chatty turn surfaces nothing (the "skills prompt on every hello" bug).
    for (const greeting of ['hello there', 'hey can you help me out', 'thanks so much for that', 'this is a test']) {
      const ctx = await buildTurnSkillContext(greeting);
      expect(ctx).toEqual({ advert: '', autoLoaded: [] });
    }
  });

  it('stays silent when the top match only shares ONE query term (incidental hit)', async () => {
    // "stripe" alone hits stripe-webhook-signing, but the rest of the turn is
    // unrelated - one shared word is not enough to justify injecting a skill.
    const ctx = await buildTurnSkillContext('stripe dashboard analytics revenue report');
    expect(ctx).toEqual({ advert: '', autoLoaded: [] });
  });

  it('returns empty when nothing in the library matches', async () => {
    const ctx = await buildTurnSkillContext('zzzzz qqqqq xxxxx nonsense gibberish');
    expect(ctx.autoLoaded).toEqual([]);
    expect(ctx.advert).toBe('');
  });

  it('excludes always-on skills from the advert and from auto-load', async () => {
    const ctx = await buildTurnSkillContext('how do I verify a stripe webhook signature', {
      alwaysOnNames: ['stripe-webhook-signing'],
    });
    // The winner is already in context → not auto-loaded, not advertised.
    expect(ctx.autoLoaded).toEqual([]);
    expect(ctx.advert).not.toContain('stripe-webhook-signing');
  });

  it('OFFERS an oversized skill instead of injecting a truncated one', async () => {
    libState.bodies = { 'stripe-webhook-signing': 'x'.repeat(5000) };
    const ctx = await buildTurnSkillContext('verify stripe webhook signature payload');

    // The old behaviour spent 3,000 characters of a body averaging 24,000 -
    // the opening 12%, usually preamble. More than a decision needs, less than
    // the work needs, and the useful case then paid for those characters twice
    // when it fetched the rest.
    expect(ctx.advert, 'the body was injected instead of offered').not.toContain('x'.repeat(500));
    expect(ctx.advert.length, 'the offer is not much smaller than the truncated body was').toBeLessThan(1200);

    // What the model needs to decide: what it is, how big, how to get it.
    expect(ctx.advert).toContain('stripe-webhook-signing');
    expect(ctx.advert, 'the offer does not say how to read it').toContain('darhai_read_skill');
    expect(ctx.advert, 'the offer does not say how large the skill is').toContain('5,000');
  });

  it('still injects a short skill whole - a pointer would cost the same', async () => {
    libState.bodies = { 'stripe-webhook-signing': '# Short skill\nDo the thing.' };
    const ctx = await buildTurnSkillContext('verify stripe webhook signature payload');

    expect(ctx.advert).toContain('Do the thing.');
    expect(ctx.advert).not.toContain('darhai_read_skill');
  });

  it('sends the model to read-by-name, not to search - it already has the names', async () => {
    // The advert lists exact skill names. Pointing at `darhai_search_skills`
    // (the tool for finding a name you do NOT have) cost a whole round-trip
    // whose output was the list the model was already holding.
    libState.bodies = {};
    const ctx = await buildTurnSkillContext('deploy a react component to a kubernetes cluster');

    expect(ctx.advert).toContain('[Relevant skills for this request]');
    expect(ctx.advert, 'the advert still routes through a search').not.toContain('darhai_search_skills');
    expect(ctx.advert).toContain('darhai_read_skill');
  });
});

describe('isAutoLoadWinner', () => {
  // These ratios are the measured trade-off documented on AUTOLOAD_MARGIN:
  // over 34 technical and 38 ordinary turns against the shipped 2,470-skill
  // index, 1.3 auto-loads on 8 technical turns and 0 ordinary ones, while 1.2
  // starts auto-loading "this is taking a long time" -> weekly-cleaning-schedule.
  const SCORE = 20;

  it('loads when the winner clears the runner-up by the measured margin', () => {
    // 1.35x - `git-workflow` beats `git-panic-recovery` by 1.37x on the real
    // corpus, and is the right skill for "recover from a bad git rebase".
    expect(isAutoLoadWinner(SCORE, SCORE / 1.35)).toBe(true);
  });

  it('stays silent on a near-tie, however high both score', () => {
    // `python-testing-patterns` vs `rust-testing-patterns` sit at 1.02x. There
    // is no winner to pick, so the advert lists both and the model chooses.
    expect(isAutoLoadWinner(SCORE, SCORE / 1.02)).toBe(false);
  });

  it('holds the line short of where an ordinary turn starts winning', () => {
    // The measured break is at a 1.2 margin, where "this is taking a long time"
    // auto-loads `weekly-cleaning-schedule`. Anything that loose must stay out:
    // a 1.25x lead is not a clear enough winner, and neither is 1.15x.
    expect(isAutoLoadWinner(SCORE, SCORE / 1.25)).toBe(false);
    expect(isAutoLoadWinner(SCORE, SCORE / 1.15)).toBe(false);
  });

  it('refuses a weak top hit even with no competition', () => {
    expect(isAutoLoadWinner(1, undefined)).toBe(false);
    expect(isAutoLoadWinner(20, undefined)).toBe(true);
  });
});
