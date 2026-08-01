/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server factory for the skill library: search, then read.
 *
 * Why it is two steps
 * -------------------
 * Search used to inline the full body of every hit. Measured against the
 * shipped library that is not a small overhead - it is the whole context:
 *
 *   2,470 skills, mean body 23.9 KB, median 18 KB, p90 48 KB
 *   default limit 25  ->   583 KB  ~149,000 tokens
 *   p90 bodies        -> 1,180 KB  ~302,000 tokens
 *   limit 100 (max)   -> ~2.4 MB   ~600,000 tokens
 *
 * Most models have a 128k-200k window, so one search filled or overflowed it
 * and the conversation died - breaking the exact capability the tool exists to
 * provide. Darhai loads this server by default, so every user met it.
 *
 * Metadata for the same 25 hits is ~12.7 KB (~3,200 tokens): 46x smaller. The
 * model reads the list, picks one, and asks for that body. That is also how a
 * person uses a library.
 *
 * The BM25 index is built once per server instance on the first call and
 * cached thereafter.
 */

import type { SkillIndexEntry } from '@/common/types/skillTypes';
import { SkillLibrary } from '@process/services/skills/SkillLibrary';
import { SkillRetriever } from '@process/services/skills/SkillRetriever';
import { BUILTIN_SEARCH_SKILLS_TOOL_NAME } from './constants';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One hit. Deliberately WITHOUT a body - see the module comment. */
export type SearchSkillHit = {
  name: string;
  description: string;
  score: number;
  /**
   * Size of the body this hit would return, in characters.
   *
   * Given to the model so it can budget before asking: "this one is 48 KB" is
   * information it cannot otherwise have, and without it the only way to find
   * out is to blow the context open.
   */
  bodyChars: number;
};

export type SearchSkillsResult = {
  results: SearchSkillHit[];
  message?: string;
};

export type ReadSkillResult = { name: string; body: string } | { name: string; error: string };

export type SearchSkillsDeps = {
  library?: {
    list(): Promise<SkillIndexEntry[]>;
    loadBody(name: string): Promise<string | null>;
  };
  retriever?: {
    retrieve(query: string, limit: number): Array<{ name: string; description: string; score: number }>;
  };
};

/**
 * Hard cap on results, independent of what the caller asks for.
 *
 * Metadata is small, but "small x unbounded" is still unbounded, and the tool
 * schema previously allowed limit=100. A list longer than this is not a better
 * answer to "which skill do I want" - it is a worse one.
 */
export const MAX_SEARCH_RESULTS = 25;
export const DEFAULT_SEARCH_RESULTS = 10;

/** Descriptions run to ~920 chars; past this a list stops being scannable. */
const MAX_DESCRIPTION_CHARS = 400;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createSearchSkillsServer = (deps: SearchSkillsDeps = {}) => {
  const library = deps.library ?? SkillLibrary.getInstance();
  let retrieverInstance = deps.retriever;
  let indexed = false;

  const ensureIndex = async () => {
    if (indexed) return;
    if (!retrieverInstance) {
      const entries = await library.list();
      SkillRetriever.resetInstance();
      retrieverInstance = SkillRetriever.getInstance({ entries });
    }
    indexed = true;
  };

  return {
    name: BUILTIN_SEARCH_SKILLS_TOOL_NAME,

    /** Rank the library. Returns metadata only. */
    async call({ query, limit }: { query: string; limit?: number }): Promise<SearchSkillsResult> {
      await ensureIndex();

      const capped = Math.min(Math.max(1, limit ?? DEFAULT_SEARCH_RESULTS), MAX_SEARCH_RESULTS);
      const hits = retrieverInstance!.retrieve(query, capped);

      if (hits.length === 0) {
        return {
          results: [],
          message: `No skills found matching '${query}' - try different terms.`,
        };
      }

      // Bodies are still loaded here, but only to measure and then discarded.
      // A hit whose body cannot be read is dropped rather than advertised,
      // because offering a name that `darhai_read_skill` will then refuse is
      // worse than not offering it: the model spends a turn to learn nothing.
      const results: SearchSkillHit[] = [];
      for (const hit of hits) {
        const body = await library.loadBody(hit.name);
        if (body === null) continue;
        results.push({
          name: hit.name,
          description: truncate(hit.description ?? '', MAX_DESCRIPTION_CHARS),
          score: hit.score,
          bodyChars: body.length,
        });
      }

      if (results.length === 0) {
        return {
          results: [],
          message: `Found ${hits.length} matching skills but none could be loaded.`,
        };
      }

      return { results };
    },

    /** Fetch ONE skill body by exact name. */
    async readSkill({ name }: { name: string }): Promise<ReadSkillResult> {
      await ensureIndex();

      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed) return { name: '', error: 'A skill name is required.' };

      const body = await library.loadBody(trimmed);
      if (body === null) {
        // `loadBody` also returns null for blocked/quarantined entries, so this
        // one message covers "does not exist" and "exists but is not allowed".
        // Distinguishing them would tell a caller which names are quarantined.
        return { name: trimmed, error: `No readable skill named '${trimmed}'. Use search to find exact names.` };
      }

      return { name: trimmed, body };
    },
  };
};

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
