/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the Deep Research feature (Odysseus assimilation "deep research").
 *
 * `start` + `cancel` are remote-denied (see bridgeAllowlist REMOTE_DENIED_KEYS):
 * a run spends the user's search + LLM keys and makes many outbound calls, so only
 * the trusted local user may drive one. The local renderer contract is still
 * untrusted input crossing a process boundary, so every field is validated / clamped
 * here (mirroring documentsBridge) before it reaches the service.
 */

import { ipcBridge } from '@/common';
import { researchService } from '@process/services/research/researchServiceSingleton';
import type { ResearchCategory, ResearchRun, StartResearchParams } from '@/common/types/research';

/** Cap on id strings (chars). */
const MAX_ID_LEN = 512;
/** Cap on the research query (chars) - generous, but bounds a hostile payload. */
const MAX_QUERY_LEN = 4_000;
/** Ceiling for a caller-supplied round count (the service clamps again). */
const MAX_ROUNDS = 5;

const VALID_CATEGORIES: ReadonlySet<string> = new Set<ResearchCategory>([
  'auto',
  'general',
  'product',
  'comparison',
  'howto',
  'factcheck',
]);

function safeString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function safeCategory(value: unknown): ResearchCategory | undefined {
  return typeof value === 'string' && VALID_CATEGORIES.has(value) ? (value as ResearchCategory) : undefined;
}

function safeRounds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(MAX_ROUNDS, Math.floor(value)));
}

function toStartParams(raw: unknown): StartResearchParams | null {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<StartResearchParams>;
  const query = safeString(source.query, MAX_QUERY_LEN).trim();
  if (!query) return null;
  const out: StartResearchParams = { query };
  const category = safeCategory(source.category);
  if (category) out.category = category;
  const rounds = safeRounds(source.rounds);
  if (rounds !== undefined) out.rounds = rounds;
  return out;
}

/** Initialize the deep-research IPC bridge handlers. */
export function initResearchBridge(): void {
  ipcBridge.research.start.provider(async ({ userId, params }): Promise<{ runId: string }> => {
    const id = safeString(userId, MAX_ID_LEN);
    if (!id) throw new Error('research.start: userId is required');
    const startParams = toStartParams(params);
    if (!startParams) throw new Error('research.start: query is required');
    return researchService.start(id, startParams);
  });

  ipcBridge.research.getRun.provider(async ({ runId }): Promise<ResearchRun | null> => {
    const id = safeString(runId, MAX_ID_LEN);
    if (!id) return null;
    return researchService.getRun(id);
  });

  ipcBridge.research.listRuns.provider(async ({ userId }): Promise<ResearchRun[]> => {
    const id = safeString(userId, MAX_ID_LEN);
    if (!id) return [];
    return researchService.listRuns(id);
  });

  ipcBridge.research.cancel.provider(async ({ runId }): Promise<void> => {
    const id = safeString(runId, MAX_ID_LEN);
    if (!id) return;
    await researchService.cancel(id);
  });
}
