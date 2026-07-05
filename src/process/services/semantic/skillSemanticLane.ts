/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill-specific wiring for the hybrid semantic lane.
 *
 * This module bridges the generic SemanticIndexService to the skill corpus:
 *   - builds the semantic documents from SkillIndexEntry rows,
 *   - schedules a background (fire-and-forget) reindex of the vector store,
 *   - augments a BM25 advert list with semantically-related skills the lexical
 *     lane missed.
 *
 * The BM25 ranking and auto-load logic in buildTurnSkillContext are left fully
 * intact: the vector lane only ADDS recall (skills BM25 didn't surface). When
 * the model or sqlite-vec is unavailable every function here is a safe no-op,
 * so behavior is identical to the pre-existing keyword-only path.
 */

import type { SkillIndexEntry } from '@/common/types/skillTypes';
import { SkillRetriever } from '@process/services/skills/SkillRetriever';
import { SemanticIndexService } from './SemanticIndexService';
import type { KeywordLane } from './HybridRetriever';
import type { SemanticDoc, SemanticHit } from './types';

/** Build the embedding text for a skill: the same fields BM25 indexes. */
function skillDocText(e: SkillIndexEntry): string {
  return [e.name, e.description, ...(e.metadata.tags ?? []), e.metadata.category ?? ''].join(' ');
}

/** Map skill entries to semantic docs (id = skill name), excluding blocked skills. */
export function skillDocs(entries: readonly SkillIndexEntry[]): SemanticDoc[] {
  return entries.filter((e) => e.security?.verdict !== 'blocked').map((e) => ({ id: e.name, text: skillDocText(e) }));
}

/**
 * Wrap an already-built BM25 retriever as a HybridRetriever keyword lane
 * (id = skill name). Reusing an existing index avoids rebuilding BM25 over the
 * full skill corpus on every turn.
 */
export function keywordLaneFromRetriever(retriever: SkillRetriever): KeywordLane {
  return (query: string, limit: number): SemanticHit[] =>
    retriever.retrieve(query, limit).map((h) => ({ id: h.name, score: h.score, source: 'keyword' as const }));
}

/**
 * A keyword lane over the given entries, backed by a private BM25 retriever.
 * Returns hits shaped for HybridRetriever (id = skill name). Prefer
 * `keywordLaneFromRetriever` when a BM25 index already exists for `entries`.
 */
function makeKeywordLane(entries: readonly SkillIndexEntry[]): KeywordLane {
  const retriever = new SkillRetriever();
  retriever.buildIndex([...entries]);
  return keywordLaneFromRetriever(retriever);
}

// Guards against re-triggering an in-flight or size-unchanged background index.
let lastIndexedCount = -1;
let indexing = false;

/**
 * Fire-and-forget background reindex of the skill vector store. Cheap to call
 * on every library load: it early-returns unless the entry count changed and no
 * pass is already running. Errors are swallowed (keyword lane stays correct).
 */
export function scheduleSkillReindex(entries: readonly SkillIndexEntry[]): void {
  if (indexing || entries.length === lastIndexedCount) return;
  indexing = true;
  void (async () => {
    try {
      const svc = SemanticIndexService.getInstance();
      if (!(await svc.isVectorAvailable())) return;
      const retriever = await svc.getRetriever('skills', makeKeywordLane(entries));
      await retriever.reindex(skillDocs(entries));
      lastIndexedCount = entries.length;
    } catch (err) {
      console.warn('[skillSemanticLane] background reindex failed:', err);
    } finally {
      indexing = false;
    }
  })();
}

/**
 * Given a BM25 advert (names already chosen by buildTurnSkillContext) and the
 * full entry set, return up to `maxExtra` ADDITIONAL skill names that the vector
 * lane ranks highly but BM25 missed. Empty when vectors are unavailable.
 *
 * This never reorders or removes BM25 picks - it only appends semantic recall,
 * so the existing lexical behavior is preserved exactly.
 */
export async function augmentSkillAdvertWithVector(
  query: string,
  entries: readonly SkillIndexEntry[],
  alreadyChosen: ReadonlySet<string>,
  maxExtra: number,
  keywordLane?: KeywordLane
): Promise<Array<{ name: string; description: string }>> {
  if (maxExtra <= 0) return [];
  try {
    const svc = SemanticIndexService.getInstance();
    if (!(await svc.isVectorAvailable())) return [];

    // Reuse the caller's existing BM25 index when supplied; otherwise build a
    // one-off lane. Reusing avoids re-indexing the full skill corpus per turn.
    const retriever = await svc.getRetriever('skills', keywordLane ?? makeKeywordLane(entries));
    const hits = await retriever.retrieve(query, maxExtra + alreadyChosen.size + 4);

    const byName = new Map(entries.map((e) => [e.name, e]));
    const extra: Array<{ name: string; description: string }> = [];
    for (const hit of hits) {
      if (hit.source !== 'vector') continue; // only add genuine semantic recall
      if (alreadyChosen.has(hit.id)) continue;
      const entry = byName.get(hit.id);
      if (!entry || entry.security?.verdict === 'blocked') continue;
      extra.push({ name: entry.name, description: entry.description });
      if (extra.length >= maxExtra) break;
    }
    return extra;
  } catch (err) {
    console.warn('[skillSemanticLane] advert augmentation failed:', err);
    return [];
  }
}
