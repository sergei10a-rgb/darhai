/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Memory-specific wiring for the hybrid semantic lane.
 *
 * Bridges SemanticIndexService to the in-memory MemoryEntry corpus owned by
 * IjfwArchiveService:
 *   - builds semantic docs from summary + body preview,
 *   - schedules background reindexing,
 *   - runs a hybrid search whose keyword lane is a substring scorer (the exact
 *     matching the archive already used), so offline behavior is unchanged.
 *
 * The archive stays the source of truth for entry data; this lane only decides
 * WHICH entry ids are relevant to a free-text query.
 */

import { SemanticIndexService } from './SemanticIndexService';
import type { KeywordLane } from './HybridRetriever';
import type { SemanticDoc, SemanticHit } from './types';

/** Minimal shape this lane needs from a memory entry (decoupled from the full type). */
export type MemoryDocInput = {
  id: string;
  summary: string;
  bodyPreview: string;
  tags: readonly string[];
};

/** Embedding text for a memory entry: summary carries the most signal, then body + tags. */
function memoryDocText(e: MemoryDocInput): string {
  return [e.summary, e.bodyPreview, ...e.tags].join(' ');
}

export function memoryDocs(entries: readonly MemoryDocInput[]): SemanticDoc[] {
  return entries.map((e) => ({ id: e.id, text: memoryDocText(e) }));
}

/**
 * A substring keyword lane - the same signal the archive's `filter.search` used
 * (case-insensitive contains over summary/body/tags), shaped for HybridRetriever.
 * Always available, so retrieval never regresses below the prior behavior.
 */
function makeKeywordLane(entries: readonly MemoryDocInput[]): KeywordLane {
  return (query: string, limit: number): SemanticHit[] => {
    const q = query.toLocaleLowerCase().trim();
    if (!q) return [];
    const scored: SemanticHit[] = [];
    for (const e of entries) {
      const summary = e.summary.toLocaleLowerCase();
      const body = e.bodyPreview.toLocaleLowerCase();
      // Summary matches weigh more than body matches; tags add a small boost.
      let score = 0;
      if (summary.includes(q)) score += 2;
      if (body.includes(q)) score += 1;
      if (e.tags.some((t) => t.toLocaleLowerCase().includes(q))) score += 0.5;
      if (score > 0) scored.push({ id: e.id, score, source: 'keyword' });
    }
    return scored.toSorted((a, b) => b.score - a.score).slice(0, limit);
  };
}

let lastIndexedCount = -1;
let indexing = false;

/** Fire-and-forget background reindex of the memory vector store. */
export function scheduleMemoryReindex(entries: readonly MemoryDocInput[]): void {
  if (indexing || entries.length === lastIndexedCount) return;
  indexing = true;
  void (async () => {
    try {
      const svc = SemanticIndexService.getInstance();
      if (!(await svc.isVectorAvailable())) return;
      const retriever = await svc.getRetriever('memory', makeKeywordLane(entries));
      await retriever.reindex(memoryDocs(entries));
      lastIndexedCount = entries.length;
    } catch (err) {
      console.warn('[memorySemanticLane] background reindex failed:', err);
    } finally {
      indexing = false;
    }
  })();
}

/**
 * Return the ranked entry ids for a free-text query, hybrid vector + keyword.
 * Falls back to the substring lane when vectors are unavailable. Returns null
 * when the semantic path threw, so the caller can keep its own filter.
 */
export async function searchMemoryIds(
  query: string,
  entries: readonly MemoryDocInput[],
  limit: number
): Promise<string[] | null> {
  try {
    const svc = SemanticIndexService.getInstance();
    const retriever = await svc.getRetriever('memory', makeKeywordLane(entries));
    const hits = await retriever.retrieve(query, limit);
    return hits.map((h) => h.id);
  } catch (err) {
    console.warn('[memorySemanticLane] search failed:', err);
    return null;
  }
}
