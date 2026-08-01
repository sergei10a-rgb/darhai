/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSearchSkillsServer } from '@process/resources/builtinMcp/searchSkillsServer';
import type { SearchSkillsDeps } from '@process/resources/builtinMcp/searchSkillsServer';
import type { SkillIndexEntry } from '@/common/types/skillTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(name: string): SkillIndexEntry {
  return {
    name,
    description: `Description for ${name}`,
    type: 'skill',
    source: 'builtin',
    path: `skills/${name}/SKILL.md`,
    metadata: { tags: [], category: 'general' },
  };
}

function makeLibrary(entries: SkillIndexEntry[], bodies: Record<string, string | null>): SearchSkillsDeps['library'] {
  const listFn = vi.fn(async () => entries);
  const loadBodyFn = vi.fn(async (name: string) => bodies[name] ?? null);
  return { list: listFn, loadBody: loadBodyFn };
}

function makeRetriever(
  hits: Array<{ name: string; description: string; score: number }>
): SearchSkillsDeps['retriever'] {
  return { retrieve: vi.fn(() => hits) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSearchSkillsServer', () => {
  describe('call - happy path', () => {
    it('returns ranked METADATA - never the bodies', async () => {
      const library = makeLibrary([makeEntry('alpha'), makeEntry('beta')], {
        alpha: '# Alpha skill body',
        beta: '# Beta skill body',
      });
      const retriever = makeRetriever([
        { name: 'alpha', description: 'Description for alpha', score: 2.5 },
        { name: 'beta', description: 'Description for beta', score: 1.2 },
      ]);

      const server = createSearchSkillsServer({ library, retriever });
      const result = await server.call({ query: 'alpha beta' });

      expect(result.message).toBeUndefined();
      expect(result.results).toHaveLength(2);
      // Bodies are the whole point of the fix: inlining them made the default
      // call ~583 KB (~149k tokens) against the shipped 2,470-skill library,
      // which filled or overflowed the model's context in one call.
      expect(result.results[0]).toEqual({
        name: 'alpha',
        description: 'Description for alpha',
        score: 2.5,
        bodyChars: '# Alpha skill body'.length,
      });
      expect(result.results[1]).toEqual({
        name: 'beta',
        description: 'Description for beta',
        score: 1.2,
        bodyChars: '# Beta skill body'.length,
      });
      expect(JSON.stringify(result), 'a skill body leaked into the search result').not.toContain('skill body');
    });

    it('passes limit to retriever', async () => {
      const library = makeLibrary([makeEntry('foo')], { foo: 'body' });
      const retriever = makeRetriever([{ name: 'foo', description: 'Description for foo', score: 1 }]);

      const server = createSearchSkillsServer({ library, retriever });
      await server.call({ query: 'foo', limit: 5 });

      expect(retriever.retrieve).toHaveBeenCalledWith('foo', 5);
    });

    it('defaults limit to 10 when not specified', async () => {
      const library = makeLibrary([makeEntry('foo')], { foo: 'body' });
      const retriever = makeRetriever([{ name: 'foo', description: 'Description for foo', score: 1 }]);

      const server = createSearchSkillsServer({ library, retriever });
      await server.call({ query: 'foo' });

      expect(retriever.retrieve).toHaveBeenCalledWith('foo', 10);
    });
  });

  describe('call - empty results', () => {
    it('returns message when retriever finds no hits', async () => {
      const library = makeLibrary([], {});
      const retriever = makeRetriever([]);

      const server = createSearchSkillsServer({ library, retriever });
      const result = await server.call({ query: 'nonexistent' });

      expect(result.results).toHaveLength(0);
      expect(result.message).toBe("No skills found matching 'nonexistent' - try different terms.");
    });

    it('returns message when all matched skills have null bodies', async () => {
      const library = makeLibrary([makeEntry('blocked-skill')], { 'blocked-skill': null });
      const retriever = makeRetriever([
        { name: 'blocked-skill', description: 'Description for blocked-skill', score: 1.5 },
      ]);

      const server = createSearchSkillsServer({ library, retriever });
      const result = await server.call({ query: 'blocked' });

      expect(result.results).toHaveLength(0);
      expect(result.message).toBe('Found 1 matching skills but none could be loaded.');
    });
  });

  describe('call - blocked/disabled skill filtering', () => {
    it('filters out skills whose loadBody returns null', async () => {
      const library = makeLibrary([makeEntry('good'), makeEntry('blocked')], { good: '# Good body', blocked: null });
      const retriever = makeRetriever([
        { name: 'good', description: 'Description for good', score: 3.0 },
        { name: 'blocked', description: 'Description for blocked', score: 2.0 },
      ]);

      const server = createSearchSkillsServer({ library, retriever });
      const result = await server.call({ query: 'skill' });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].name).toBe('good');
      expect(result.message).toBeUndefined();
    });
  });

  describe('BM25 index is built only once', () => {
    it('calls library.list exactly once across multiple calls', async () => {
      const library = makeLibrary([makeEntry('one')], { one: 'body one' });
      const retriever = makeRetriever([{ name: 'one', description: 'Description for one', score: 1 }]);

      const server = createSearchSkillsServer({ library, retriever });

      await server.call({ query: 'one' });
      await server.call({ query: 'one' });
      await server.call({ query: 'one' });

      // list is called by ensureIndex which short-circuits after first build
      // Since retriever is injected directly, list is never called at all
      expect(library.list).not.toHaveBeenCalled();
    });

    it('calls library.list once when no retriever is injected and index is cold', async () => {
      // Use a real SkillRetriever by not injecting one, but inject a library
      // so we can spy on list without hitting the filesystem.
      const entries = [makeEntry('real-skill')];
      const library = makeLibrary(entries, { 'real-skill': '# Real body' });

      // Do NOT inject a retriever - let ensureIndex build one from library.list()
      const server = createSearchSkillsServer({ library });

      await server.call({ query: 'real' });
      await server.call({ query: 'real' });

      expect(library.list).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Read-one-skill, and the size property the split exists to guarantee
// ---------------------------------------------------------------------------

describe('readSkill - the second half of the two-step flow', () => {
  it('returns the full body for an exact name', async () => {
    const library = makeLibrary([makeEntry('alpha')], { alpha: '# Alpha skill body\nwith detail' });
    const retriever = makeRetriever([]);
    const server = createSearchSkillsServer({ library, retriever });

    const result = await server.readSkill({ name: 'alpha' });

    // Truncating here would defeat the point: search deliberately withholds
    // the body so that THIS call can return all of it.
    expect(result).toEqual({ name: 'alpha', body: '# Alpha skill body\nwith detail' });
  });

  it('trims surrounding whitespace in the name', async () => {
    const library = makeLibrary([makeEntry('alpha')], { alpha: 'body' });
    const server = createSearchSkillsServer({ library, retriever: makeRetriever([]) });

    expect(await server.readSkill({ name: '  alpha  ' })).toEqual({ name: 'alpha', body: 'body' });
  });

  it('reports a readable error for an unknown name instead of throwing', async () => {
    const library = makeLibrary([makeEntry('alpha')], { alpha: 'body' });
    const server = createSearchSkillsServer({ library, retriever: makeRetriever([]) });

    const result = await server.readSkill({ name: 'does-not-exist' });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('does-not-exist');
  });

  it('does not distinguish blocked from missing', async () => {
    // `loadBody` returns null for quarantined entries too. Saying which is
    // which would tell a caller exactly what has been quarantined.
    const library = makeLibrary([makeEntry('blocked')], { blocked: null });
    const server = createSearchSkillsServer({ library, retriever: makeRetriever([]) });

    const missing = await server.readSkill({ name: 'nope' });
    const blocked = await server.readSkill({ name: 'blocked' });

    expect((missing as { error: string }).error.replace('nope', 'X')).toBe(
      (blocked as { error: string }).error.replace('blocked', 'X')
    );
  });

  it('refuses an empty name', async () => {
    const server = createSearchSkillsServer({
      library: makeLibrary([], {}),
      retriever: makeRetriever([]),
    });

    expect(await server.readSkill({ name: '   ' })).toHaveProperty('error');
  });
});

describe('a search result stays small no matter what is asked for', () => {
  /** A library shaped like the real one: 24 KB bodies, 480-char descriptions. */
  function bigLibrary(count: number) {
    const entries = Array.from({ length: count }, (_, i) => makeEntry(`skill-${i}`));
    const bodies: Record<string, string> = {};
    for (const e of entries) bodies[e.name] = 'x'.repeat(24_000);
    const hits = entries.map((e, i) => ({
      name: e.name,
      description: 'd'.repeat(900),
      score: count - i,
    }));
    return { library: makeLibrary(entries, bodies), retriever: makeRetriever(hits) };
  }

  it('caps the result count even when the caller asks for far more', async () => {
    const { library, retriever } = bigLibrary(200);
    const server = createSearchSkillsServer({ library, retriever });

    await server.call({ query: 'anything', limit: 500 });

    // The schema caps this too, but a caller that ignores the schema - or a
    // future caller inside the app - must not be able to exceed it either.
    expect(retriever.retrieve).toHaveBeenCalledWith('anything', 25);
  });

  it('a max-size search stays under 20 KB, not 583 KB', async () => {
    // The regression this file exists for. With bodies inlined, 25 hits of a
    // real-sized library serialise to ~600 KB (~149k tokens) and one search
    // ends the conversation. This is the number that must not come back.
    const { library, retriever } = bigLibrary(25);
    const server = createSearchSkillsServer({ library, retriever });

    const result = await server.call({ query: 'anything', limit: 25 });
    const serialised = JSON.stringify(result);

    expect(result.results).toHaveLength(25);
    expect(serialised.length, `search result was ${Math.round(serialised.length / 1024)} KB`).toBeLessThan(20_000);
    expect(serialised, 'a body leaked into the result').not.toContain('x'.repeat(500));
  });

  it('truncates a runaway description', async () => {
    const { library, retriever } = bigLibrary(1);
    const server = createSearchSkillsServer({ library, retriever });

    const result = await server.call({ query: 'anything' });

    expect(result.results[0].description.length).toBeLessThanOrEqual(400);
  });

  it('still reports the body size so the model can budget before fetching', async () => {
    const { library, retriever } = bigLibrary(1);
    const server = createSearchSkillsServer({ library, retriever });

    const result = await server.call({ query: 'anything' });

    expect(result.results[0].bodyChars).toBe(24_000);
  });
});
