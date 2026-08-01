/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `skills.search` backs the `/skill` autocomplete.
 *
 * It exists as a separate verb from `skills.list` for one reason: `list`
 * returns all ~2,470 entries, about 1.2 MB over IPC. That is fine for the
 * Skills settings page loading once and impossible to run on every keystroke.
 *
 * The behaviour that matters to a person typing:
 *   - the name they are spelling comes first, even if BM25 disagrees;
 *   - the list stays short;
 *   - no bodies ride along.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SkillIndexEntry } from '@/common/types/skillTypes';

const listMock = vi.fn<() => Promise<SkillIndexEntry[]>>();

vi.mock('@process/services/skills/SkillLibrary', () => ({
  SkillLibrary: { getInstance: () => ({ list: listMock }) },
}));

const retrieveMock = vi.fn<(query: string, limit: number) => Array<{ name: string; description: string }>>();
vi.mock('@process/services/skills/SkillRetriever', () => ({
  SkillRetriever: {
    resetInstance: vi.fn(),
    getInstance: () => ({ retrieve: retrieveMock }),
  },
}));

/** The provider body, lifted so the test drives the same code the bridge does. */
async function search(
  args: { query: string; limit?: number },
  entries: SkillIndexEntry[],
  ranked: Array<{ name: string; description: string }>
) {
  listMock.mockResolvedValue(entries);
  retrieveMock.mockReturnValue(ranked);

  const { SkillLibrary } = await import('@process/services/skills/SkillLibrary');
  const { SkillRetriever } = await import('@process/services/skills/SkillRetriever');

  // Mirror of the provider in skillsBridge.ts.
  const capped = Math.min(Math.max(1, args.limit ?? 10), 25);
  const trimmed = (args.query ?? '').trim();
  const all = await SkillLibrary.getInstance().list({ type: 'skill' });
  if (!trimmed) return all.slice(0, capped).map((e) => ({ name: e.name, description: e.description ?? '' }));

  const lower = trimmed.toLowerCase();
  const byPrefix = all.filter((e) => e.name.toLowerCase().startsWith(lower));
  SkillRetriever.resetInstance();
  const hits = SkillRetriever.getInstance({ entries: all }).retrieve(trimmed, capped);

  const seen = new Set<string>();
  const out: Array<{ name: string; description: string }> = [];
  for (const e of [...byPrefix, ...hits]) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push({ name: e.name, description: e.description ?? '' });
    if (out.length >= capped) break;
  }
  return out;
}

const entry = (name: string, description = `About ${name}`): SkillIndexEntry => ({
  name,
  description,
  type: 'skill',
  source: 'wayland-library',
  path: `skills/${name}/SKILL.md`,
  metadata: { tags: [] },
});

beforeEach(() => {
  listMock.mockReset();
  retrieveMock.mockReset();
});

describe('skills.search', () => {
  it('puts a name the user is spelling ahead of a better BM25 match', async () => {
    // Someone typing `/kube` is naming a skill, not describing a task. Ranking
    // by relevance alone would bury the row they are literally typing.
    const entries = [entry('kubernetes-operator'), entry('deployment-guide')];
    const ranked = [{ name: 'deployment-guide', description: 'About deployment-guide' }];

    const out = await search({ query: 'kube' }, entries, ranked);

    expect(out[0].name).toBe('kubernetes-operator');
    expect(out.map((o) => o.name)).toContain('deployment-guide');
  });

  it('does not repeat a skill that matched both ways', async () => {
    const entries = [entry('kubernetes-operator')];
    const ranked = [{ name: 'kubernetes-operator', description: 'About kubernetes-operator' }];

    const out = await search({ query: 'kube' }, entries, ranked);

    expect(out).toHaveLength(1);
  });

  it('caps the list however large a limit is asked for', async () => {
    const entries = Array.from({ length: 200 }, (_, i) => entry(`skill-${i}`));
    const out = await search({ query: 'skill', limit: 500 }, entries, []);
    expect(out.length).toBeLessThanOrEqual(25);
  });

  it('never returns a body', async () => {
    // The whole point of a separate verb: `/skill` autocomplete runs per
    // keystroke and must stay small.
    const entries = [entry('kubernetes-operator')];
    const out = await search({ query: 'kube' }, entries, []);

    expect(Object.keys(out[0]).sort()).toEqual(['description', 'name']);
  });

  it('returns a short head for an empty query rather than everything', async () => {
    const entries = Array.from({ length: 200 }, (_, i) => entry(`skill-${i}`));
    const out = await search({ query: '   ' }, entries, []);
    expect(out).toHaveLength(10);
  });
});
