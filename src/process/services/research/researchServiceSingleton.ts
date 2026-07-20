/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Production wiring for the Deep Research service.
 *
 * This is the ONLY place the loop is bound to concrete Darhai primitives:
 *   - `search`        -> the `web_search` builtin's in-process `.call`, fed the
 *                        encrypted search keys from the ToolKeyStore rail
 *   - `fetchAndRead`  -> the new primitive, handed the optional Firecrawl key
 *   - `completeFast`  -> `oneShotComplete` with the cheapest fast model
 *   - `completeBest`  -> `oneShotComplete` with the most capable model
 *
 * No new LLM client and no new agent loop are introduced - the service composes
 * primitives Darhai already owns.
 */

import { getToolKeyStore } from '@process/agent/wcore/toolKeyStore';
import { createWebSearchServer } from '@process/resources/builtinMcp/webSearchServer';
import { oneShotComplete, pickBestModel, pickCheapestFastModel } from '@process/services/completion/oneShot';
import { fetchAndRead } from './fetchAndRead';
import { IpcResearchEventEmitter } from './IpcResearchEventEmitter';
import { ResearchService, type ResearchEngineDeps } from './ResearchService';
import { SqliteResearchRunRepository } from './SqliteResearchRunRepository';
import type { WebSearchResult } from '@process/resources/builtinMcp/webSearchServer';

/** Generous single-response cap so extractions aren't truncated. */
const EXTRACT_MAX_TOKENS = 2_000;
/** Heavy generation cap for synthesis + the final long-form report. */
const REPORT_MAX_TOKENS = 4_000;
/** Per-call wall-clock ceiling - a stuck endpoint must not hang a run. */
const COMPLETE_TIMEOUT_MS = 120_000;

/**
 * Reuse the `web_search` builtin in-process (no MCP hop): build a server bound
 * to the user's stored search keys and call it directly. Keys come from the same
 * encrypted ToolKeyStore rail the engine uses.
 */
async function searchViaBuiltin(query: string, count: number): Promise<WebSearchResult[]> {
  const store = await getToolKeyStore();
  const env = { ...process.env, ...store.collectForwardedEnv() };
  const server = createWebSearchServer({ env });
  const response = await server.call({ query, count });
  return response.results;
}

/** Fetch + read a URL, preferring the clean-scrape path when a Firecrawl key exists. */
async function fetchAndReadWithKey(url: string) {
  const store = await getToolKeyStore();
  return fetchAndRead(url, { firecrawlKey: store.getToolKey('firecrawl') });
}

async function completeFast(prompt: string): Promise<string> {
  const model = await pickCheapestFastModel();
  return oneShotComplete(prompt, {
    model: model ?? undefined,
    maxTokens: EXTRACT_MAX_TOKENS,
    timeoutMs: COMPLETE_TIMEOUT_MS,
  });
}

async function completeBest(prompt: string): Promise<string> {
  const model = await pickBestModel();
  return oneShotComplete(prompt, {
    model: model ?? undefined,
    maxTokens: REPORT_MAX_TOKENS,
    timeoutMs: COMPLETE_TIMEOUT_MS,
  });
}

const engineDeps: ResearchEngineDeps = {
  search: searchViaBuiltin,
  fetchAndRead: fetchAndReadWithKey,
  completeFast,
  completeBest,
  now: () => Date.now(),
};

export const researchService = new ResearchService(
  new SqliteResearchRunRepository(),
  new IpcResearchEventEmitter(),
  engineDeps
);
