/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRetriever } from '@process/services/skills/SkillRetriever';
import type { SkillIndexEntry } from '@/common/types/skillTypes';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const entry = (overrides: Partial<SkillIndexEntry> = {}): SkillIndexEntry => ({
  name: overrides.name ?? 'sample-skill',
  description: overrides.description ?? 'A sample skill for testing',
  type: 'skill',
  source: 'wayland-library',
  metadata: {
    tags: overrides.metadata?.tags ?? ['testing'],
    category: overrides.metadata?.category ?? 'dev',
  },
  path: `bodies/${overrides.name ?? 'sample-skill'}.md`,
  security: overrides.security,
});

const FIXTURES: SkillIndexEntry[] = [
  entry({
    name: 'python-project-setup',
    description: 'Set up a new Python project with virtual environments and dependencies',
    metadata: { tags: ['python', 'virtualenv', 'pip'], category: 'software-engineering' },
  }),
  entry({
    name: 'react-component',
    description: 'Generate a React functional component with hooks',
    metadata: { tags: ['react', 'frontend', 'hooks'], category: 'frontend' },
  }),
  entry({
    name: 'kube-deploy',
    description: 'Deploy an application to Kubernetes cluster',
    metadata: { tags: ['kubernetes', 'devops', 'docker'], category: 'devops' },
  }),
  entry({
    name: 'blocked-skill',
    description: 'This skill is blocked and should not appear',
    metadata: { tags: ['blocked'], category: 'security' },
    security: { verdict: 'blocked', findings: [], scannedAt: 0, scannerVersion: 1, llmScanned: false },
  }),
  entry({
    name: 'sql-query',
    description: 'Write optimized SQL queries for relational databases',
    metadata: { tags: ['sql', 'database', 'postgres'], category: 'database' },
  }),
  entry({
    name: 'git-workflow',
    description: 'Manage Git branching and merge workflows',
    metadata: { tags: ['git', 'version-control'], category: 'software-engineering' },
  }),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillRetriever', () => {
  beforeEach(() => {
    SkillRetriever.resetInstance();
  });

  describe('tokenization', () => {
    it('lowercases query terms when retrieving', () => {
      const r = new SkillRetriever({ entries: FIXTURES });
      const upper = r.retrieve('PYTHON');
      const lower = r.retrieve('python');
      // Both should return the same results
      expect(upper.map((x) => x.name)).toEqual(lower.map((x) => x.name));
    });

    it('splits on word boundaries', () => {
      const r = new SkillRetriever({ entries: FIXTURES });
      const results = r.retrieve('python project');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('python-project-setup');
    });
  });

  describe('Unicode / Cyrillic tokenization', () => {
    const CYRILLIC_FIXTURES: SkillIndexEntry[] = [
      entry({
        name: 'mongol-tekst',
        description: 'Монгол хэл дээрх текст боловсруулах ур чадвар',
        metadata: { tags: ['монгол', 'текст'], category: 'хэл' },
      }),
      entry({
        name: 'react-component',
        description: 'Generate a React functional component with hooks',
        metadata: { tags: ['react'], category: 'frontend' },
      }),
    ];

    it('matches a Cyrillic query against a Cyrillic skill', () => {
      const r = new SkillRetriever({ entries: CYRILLIC_FIXTURES });
      const results = r.retrieve('монгол текст');
      expect(results.map((x) => x.name)).toContain('mongol-tekst');
      expect(results[0].name).toBe('mongol-tekst');
    });

    it('does not match a Cyrillic query against a Latin-only skill', () => {
      const r = new SkillRetriever({ entries: CYRILLIC_FIXTURES });
      const results = r.retrieve('боловсруулах');
      expect(results.map((x) => x.name)).not.toContain('react-component');
    });

    it('casefolds Cyrillic queries (uppercase == lowercase)', () => {
      const r = new SkillRetriever({ entries: CYRILLIC_FIXTURES });
      const upper = r.retrieve('МОНГОЛ');
      const lower = r.retrieve('монгол');
      expect(upper.map((x) => x.name)).toEqual(lower.map((x) => x.name));
      expect(lower.map((x) => x.name)).toContain('mongol-tekst');
    });
  });

  describe('transliterated technical terms', () => {
    /**
     * Folding happens inside the tokenizer, so it covers documents as well as
     * queries. That is deliberate and load-bearing: `darhai_search_skills`
     * hands a raw model-written query straight to `retrieve()` without going
     * through `discriminativeQueryTerms`, so the query-side canonicalization in
     * the per-turn path would not help it. These tests pin the retriever's own
     * behaviour rather than the per-turn pipeline's.
     */
    const TRANSLIT_FIXTURES: SkillIndexEntry[] = [
      entry({
        name: 'python-project-setup',
        description: 'Set up a new Python project with virtual environments',
        metadata: { tags: ['python', 'pytest'], category: 'software-engineering' },
      }),
      entry({
        name: 'kube-deploy',
        description: 'Deploy an application to a Kubernetes cluster with Docker images',
        metadata: { tags: ['kubernetes', 'docker'], category: 'devops' },
      }),
      entry({
        name: 'mongol-veb-dizain',
        description: 'Вэб сайтын дизайн хийх заавар',
        metadata: { tags: ['дизайн'], category: 'хэл' },
      }),
    ];

    it('finds an English skill from a Cyrillic-transliterated query', () => {
      const r = new SkillRetriever({ entries: TRANSLIT_FIXTURES });
      expect(r.retrieve('пайтон пайтэст')[0].name).toBe('python-project-setup');
      expect(r.retrieve('докер кубернетес')[0].name).toBe('kube-deploy');
    });

    it('finds an English skill from a Latin-romanized query', () => {
      const r = new SkillRetriever({ entries: TRANSLIT_FIXTURES });
      expect(r.retrieve('paiton paitest')[0].name).toBe('python-project-setup');
      expect(r.retrieve('doker kubernetis')[0].name).toBe('kube-deploy');
    });

    it('finds a Cyrillic-described skill from an English query', () => {
      // The other direction: documents are folded too, so the ~100
      // Cyrillic-described skills in the shipped library stop being invisible
      // to an English-speaking model.
      const r = new SkillRetriever({ entries: TRANSLIT_FIXTURES });
      expect(r.retrieve('web design')[0].name).toBe('mongol-veb-dizain');
    });

    it('counts a term and its transliteration as ONE shared term', () => {
      // matchedTerms drives the relevance gate, so a single concept spelled two
      // ways must not be able to clear a two-term floor on its own.
      const r = new SkillRetriever({ entries: TRANSLIT_FIXTURES });
      expect(r.maxSharedTerms('python пайтон paiton')).toBe(1);
    });

    it('leaves an English query and English documents untouched', () => {
      const r = new SkillRetriever({ entries: TRANSLIT_FIXTURES });
      expect(r.retrieve('python project setup')[0].name).toBe('python-project-setup');
      expect(r.retrieve('kubernetes docker')[0].name).toBe('kube-deploy');
    });
  });

  describe('retrieve', () => {
    it('returns the matching skill in top results for an exact name query', () => {
      const r = new SkillRetriever({ entries: FIXTURES });
      const results = r.retrieve('python project setup');
      const names = results.map((x) => x.name);
      expect(names).toContain('python-project-setup');
      expect(names[0]).toBe('python-project-setup');
    });

    it('returns results sorted by score descending', () => {
      const r = new SkillRetriever({ entries: FIXTURES });
      const results = r.retrieve('kubernetes deploy');
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('respects the limit parameter', () => {
      const r = new SkillRetriever({ entries: FIXTURES });
      // A broad query that would match many skills
      const results = r.retrieve('skill', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns at most limit results even when more match', () => {
      // Build a larger fixture set
      const many: SkillIndexEntry[] = Array.from({ length: 50 }, (_, i) =>
        entry({ name: `skill-${i}`, description: `test skill number ${i}` })
      );
      const r = new SkillRetriever({ entries: many });
      const results = r.retrieve('skill test', 10);
      expect(results.length).toBeLessThanOrEqual(10);
    });

    it('returns empty array for a query with no matching terms', () => {
      const r = new SkillRetriever({ entries: FIXTURES });
      const results = r.retrieve('zzznonexistentterm999');
      expect(results).toEqual([]);
    });

    it('each result has name, description, and score fields', () => {
      const r = new SkillRetriever({ entries: FIXTURES });
      const results = r.retrieve('react component');
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(typeof result.name).toBe('string');
        expect(typeof result.description).toBe('string');
        expect(typeof result.score).toBe('number');
        expect(result.score).toBeGreaterThan(0);
      }
    });
  });

  describe('blocked skill exclusion', () => {
    it('excludes blocked skills from results', () => {
      const r = new SkillRetriever({ entries: FIXTURES });
      const results = r.retrieve('blocked skill security');
      const names = results.map((x) => x.name);
      expect(names).not.toContain('blocked-skill');
    });

    it('does not index blocked skills at all', () => {
      const r = new SkillRetriever({ entries: FIXTURES });
      // Force index build
      r.buildIndex(FIXTURES);
      // Any query should not surface blocked-skill
      const results = r.retrieve('blocked');
      expect(results.map((x) => x.name)).not.toContain('blocked-skill');
    });
  });

  describe('buildIndex', () => {
    it('can be called explicitly before retrieve', () => {
      const r = new SkillRetriever();
      r.buildIndex(FIXTURES);
      const results = r.retrieve('sql database query');
      expect(results.map((x) => x.name)).toContain('sql-query');
    });

    it('rebuilding index replaces the previous one', () => {
      const r = new SkillRetriever({ entries: FIXTURES });
      const fresh: SkillIndexEntry[] = [
        entry({
          name: 'only-skill',
          description: 'the one and only skill here',
          metadata: { tags: ['unique'], category: 'test' },
        }),
      ];
      r.buildIndex(fresh);
      const results = r.retrieve('only skill here');
      expect(results.map((x) => x.name)).toContain('only-skill');
      expect(results.map((x) => x.name)).not.toContain('python-project-setup');
    });
  });

  describe('singleton', () => {
    it('getInstance returns the same instance', () => {
      const a = SkillRetriever.getInstance({ entries: FIXTURES });
      const b = SkillRetriever.getInstance();
      expect(a).toBe(b);
    });

    it('resetInstance causes getInstance to return a new instance', () => {
      const a = SkillRetriever.getInstance({ entries: FIXTURES });
      SkillRetriever.resetInstance();
      const b = SkillRetriever.getInstance({ entries: FIXTURES });
      expect(a).not.toBe(b);
    });
  });
});
