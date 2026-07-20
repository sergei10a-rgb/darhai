/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server factory for the `web_search` tool.
 *
 * Returns an object with a single `call` method - not a stdio server. The
 * stdio entrypoint (`webSearchServerEntry.ts`) wires it into an McpServer.
 *
 * Provider resolution
 * -------------------
 * The provider is chosen by which API key is present in the process env, in a
 * fixed preference order. The key VALUES are injected into the subprocess spawn
 * env at registration time by `ensureBuiltinMcpServers`, resolved from the
 * encrypted `ToolKeyStore` (the same rail the wcore engine uses). This module
 * NEVER reads the key store directly - keeping the subprocess bundle lean and
 * free of DB/ProcessConfig side effects (see `SkillLibrary` note).
 *
 * The env var NAMES below MUST stay in sync with `TOOL_KEY_ENV_MAP` in
 * `@process/agent/wcore/toolKeyStore`. They are duplicated (not imported) on
 * purpose: importing the store would pull the SQLite/creds rail into a plain
 * `node` subprocess. A drift-guard test asserts the two agree.
 *
 * Privacy / safety
 * ---------------
 * - Bounded: `count` is clamped to [1, MAX_WEB_SEARCH_COUNT].
 * - Timed out: every provider fetch aborts after ~10s.
 * - No key configured -> a typed `WebSearchConfigError` (never a raw throw that
 *   escapes the tool boundary; the entry maps it to a typed MCP error).
 * - No secrets are logged, and provider brand names never appear in any
 *   user-facing string (results, messages, or error text).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single normalized web-search hit. */
export type WebSearchResult = { title: string; url: string; snippet: string };

/** The tool response shape. */
export type WebSearchResponse = { results: WebSearchResult[]; message?: string };

/** Provider preference order - first present key wins. */
export const WEB_SEARCH_PROVIDER_ORDER = ['tavily', 'brave', 'exa'] as const;

export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_ORDER)[number];

/**
 * Env var NAME each provider's key is forwarded under. MUST match
 * `TOOL_KEY_ENV_MAP` in the wcore tool-key store (drift-guarded by a test).
 */
export const WEB_SEARCH_PROVIDER_ENV_VAR: Record<WebSearchProviderId, string> = {
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_SEARCH_API_KEY',
  exa: 'EXA_API_KEY',
};

/** Maximum results returned per call (bounded to protect the agent context). */
export const MAX_WEB_SEARCH_COUNT = 10;

const DEFAULT_WEB_SEARCH_COUNT = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Thrown when no provider key is present. Carries a stable `code` so callers
 * can distinguish a configuration gap from a transient network failure.
 */
export class WebSearchConfigError extends Error {
  readonly code = 'no_provider_configured';
  constructor(message: string) {
    super(message);
    this.name = 'WebSearchConfigError';
  }
}

export type WebSearchDeps = {
  /** Env source (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Fetch implementation (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (defaults to 10_000). */
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Provider fetchers (each normalizes to WebSearchResult[])
// ---------------------------------------------------------------------------

type ProviderFetch = (
  key: string,
  query: string,
  count: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal
) => Promise<WebSearchResult[]>;

/** Coerce an arbitrary value to a trimmed string, or '' when absent. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Map a raw provider item array into normalized results, dropping entries without a URL. */
function normalizeItems(items: unknown, map: (item: Record<string, unknown>) => WebSearchResult): WebSearchResult[] {
  if (!Array.isArray(items)) return [];
  const out: WebSearchResult[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const mapped = map(item as Record<string, unknown>);
    if (mapped.url.length > 0) out.push(mapped);
  }
  return out;
}

/** Raise a provider-agnostic error for a non-OK HTTP response (no brand, no key). */
function assertOk(status: number, ok: boolean): void {
  if (!ok) {
    throw new Error(`Web search request failed (HTTP ${status}).`);
  }
}

const fetchTavily: ProviderFetch = async (key, query, count, fetchImpl, signal) => {
  const res = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: count }),
    signal,
  });
  assertOk(res.status, res.ok);
  const data = (await res.json()) as { results?: unknown };
  return normalizeItems(data.results, (item) => ({
    title: asText(item.title),
    url: asText(item.url),
    snippet: asText(item.content),
  }));
};

const fetchBrave: ProviderFetch = async (key, query, count, fetchImpl, signal) => {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  const res = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal,
  });
  assertOk(res.status, res.ok);
  const data = (await res.json()) as { web?: { results?: unknown } };
  return normalizeItems(data.web?.results, (item) => ({
    title: asText(item.title),
    url: asText(item.url),
    snippet: asText(item.description),
  }));
};

const fetchExa: ProviderFetch = async (key, query, count, fetchImpl, signal) => {
  const res = await fetchImpl('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query, numResults: count }),
    signal,
  });
  assertOk(res.status, res.ok);
  const data = (await res.json()) as { results?: unknown };
  return normalizeItems(data.results, (item) => ({
    title: asText(item.title),
    url: asText(item.url),
    snippet: asText(item.text ?? item.snippet),
  }));
};

const PROVIDER_FETCHERS: Record<WebSearchProviderId, ProviderFetch> = {
  tavily: fetchTavily,
  brave: fetchBrave,
  exa: fetchExa,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createWebSearchServer = (deps: WebSearchDeps = {}) => {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** First provider (in preference order) whose key is present, or null. */
  const selectProvider = (): { id: WebSearchProviderId; key: string } | null => {
    for (const id of WEB_SEARCH_PROVIDER_ORDER) {
      const key = env[WEB_SEARCH_PROVIDER_ENV_VAR[id]];
      if (typeof key === 'string' && key.trim().length > 0) {
        return { id, key: key.trim() };
      }
    }
    return null;
  };

  return {
    name: 'web_search',

    /** The provider that would be used right now, or null when none configured. */
    activeProvider(): WebSearchProviderId | null {
      return selectProvider()?.id ?? null;
    },

    async call({
      query,
      count = DEFAULT_WEB_SEARCH_COUNT,
    }: {
      query: string;
      count?: number;
    }): Promise<WebSearchResponse> {
      const trimmedQuery = typeof query === 'string' ? query.trim() : '';
      if (trimmedQuery.length === 0) {
        return { results: [], message: 'Query must be a non-empty string.' };
      }

      const bounded = Math.max(
        1,
        Math.min(MAX_WEB_SEARCH_COUNT, Math.floor(Number(count) || DEFAULT_WEB_SEARCH_COUNT))
      );

      const selected = selectProvider();
      if (!selected) {
        throw new WebSearchConfigError(
          'No web-search provider is configured. Add a search API key in Settings to enable web search.'
        );
      }

      const signal = AbortSignal.timeout(timeoutMs);
      const fetcher = PROVIDER_FETCHERS[selected.id];
      const hits = await fetcher(selected.key, trimmedQuery, bounded, fetchImpl, signal);
      const results = hits.slice(0, bounded);

      if (results.length === 0) {
        return { results: [], message: `No web results found for '${trimmedQuery}'.` };
      }
      return { results };
    },
  };
};
