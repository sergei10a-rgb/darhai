/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createWebSearchServer,
  MAX_WEB_SEARCH_COUNT,
  WebSearchConfigError,
  WEB_SEARCH_PROVIDER_ENV_VAR,
} from '@process/resources/builtinMcp/webSearchServer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonBody = Record<string, unknown>;

/** Build a fetch mock that records calls and returns a fixed JSON body. */
function makeFetch(body: JsonBody, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const TAVILY_ENV = WEB_SEARCH_PROVIDER_ENV_VAR.tavily;
const BRAVE_ENV = WEB_SEARCH_PROVIDER_ENV_VAR.brave;
const EXA_ENV = WEB_SEARCH_PROVIDER_ENV_VAR.exa;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWebSearchServer', () => {
  describe('provider selection by available key', () => {
    it('prefers Tavily when its key is present (even with all keys)', async () => {
      const fetchImpl = makeFetch({ results: [{ title: 't', url: 'https://a', content: 's' }] });
      const server = createWebSearchServer({
        env: { [TAVILY_ENV]: 'k-tav', [BRAVE_ENV]: 'k-bra', [EXA_ENV]: 'k-exa' },
        fetchImpl,
      });

      expect(server.activeProvider()).toBe('tavily');
      await server.call({ query: 'hello' });

      const calledUrl = String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
      expect(calledUrl).toContain('api.tavily.com');
    });

    it('falls back to Brave when Tavily is absent', async () => {
      const fetchImpl = makeFetch({ web: { results: [{ title: 't', url: 'https://a', description: 's' }] } });
      const server = createWebSearchServer({
        env: { [BRAVE_ENV]: 'k-bra', [EXA_ENV]: 'k-exa' },
        fetchImpl,
      });

      expect(server.activeProvider()).toBe('brave');
      await server.call({ query: 'hello' });

      const calledUrl = String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
      expect(calledUrl).toContain('api.search.brave.com');
    });

    it('falls back to Exa when only its key is present', async () => {
      const fetchImpl = makeFetch({ results: [{ title: 't', url: 'https://a', text: 's' }] });
      const server = createWebSearchServer({ env: { [EXA_ENV]: 'k-exa' }, fetchImpl });

      expect(server.activeProvider()).toBe('exa');
      await server.call({ query: 'hello' });

      const calledUrl = String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
      expect(calledUrl).toContain('api.exa.ai');
    });

    it('ignores blank/whitespace keys when selecting', async () => {
      const fetchImpl = makeFetch({ results: [{ title: 't', url: 'https://a', text: 's' }] });
      const server = createWebSearchServer({
        env: { [TAVILY_ENV]: '   ', [BRAVE_ENV]: '', [EXA_ENV]: 'k-exa' },
        fetchImpl,
      });

      expect(server.activeProvider()).toBe('exa');
    });
  });

  describe('result normalization', () => {
    it('normalizes Tavily content -> snippet', async () => {
      const fetchImpl = makeFetch({
        results: [{ title: 'Title A', url: 'https://a.example', content: 'Snippet A' }],
      });
      const server = createWebSearchServer({ env: { [TAVILY_ENV]: 'k' }, fetchImpl });
      const res = await server.call({ query: 'q' });

      expect(res.results).toEqual([{ title: 'Title A', url: 'https://a.example', snippet: 'Snippet A' }]);
    });

    it('normalizes Brave web.results description -> snippet', async () => {
      const fetchImpl = makeFetch({
        web: { results: [{ title: 'Title B', url: 'https://b.example', description: 'Snippet B' }] },
      });
      const server = createWebSearchServer({ env: { [BRAVE_ENV]: 'k' }, fetchImpl });
      const res = await server.call({ query: 'q' });

      expect(res.results).toEqual([{ title: 'Title B', url: 'https://b.example', snippet: 'Snippet B' }]);
    });

    it('normalizes Exa text -> snippet', async () => {
      const fetchImpl = makeFetch({
        results: [{ title: 'Title C', url: 'https://c.example', text: 'Snippet C' }],
      });
      const server = createWebSearchServer({ env: { [EXA_ENV]: 'k' }, fetchImpl });
      const res = await server.call({ query: 'q' });

      expect(res.results).toEqual([{ title: 'Title C', url: 'https://c.example', snippet: 'Snippet C' }]);
    });

    it('drops items without a URL and tolerates missing fields', async () => {
      const fetchImpl = makeFetch({
        results: [{ title: 'no-url', content: 'x' }, { url: 'https://ok.example' }],
      });
      const server = createWebSearchServer({ env: { [TAVILY_ENV]: 'k' }, fetchImpl });
      const res = await server.call({ query: 'q' });

      expect(res.results).toEqual([{ title: '', url: 'https://ok.example', snippet: '' }]);
    });
  });

  describe('count bounds', () => {
    it('caps count at MAX_WEB_SEARCH_COUNT and slices results', async () => {
      const many = Array.from({ length: 20 }, (_, i) => ({
        title: `t${i}`,
        url: `https://x${i}.example`,
        content: `s${i}`,
      }));
      const fetchImpl = makeFetch({ results: many });
      const server = createWebSearchServer({ env: { [TAVILY_ENV]: 'k' }, fetchImpl });

      const res = await server.call({ query: 'q', count: 50 });

      expect(res.results).toHaveLength(MAX_WEB_SEARCH_COUNT);

      // The bounded count is forwarded to the provider request body.
      const init = (fetchImpl as unknown as { mock: { calls: [unknown, { body: string }][] } }).mock.calls[0][1];
      expect(JSON.parse(init.body).max_results).toBe(MAX_WEB_SEARCH_COUNT);
    });

    it('defaults count to 5 when omitted', async () => {
      const fetchImpl = makeFetch({ results: [{ title: 't', url: 'https://a', content: 's' }] });
      const server = createWebSearchServer({ env: { [TAVILY_ENV]: 'k' }, fetchImpl });

      await server.call({ query: 'q' });

      const init = (fetchImpl as unknown as { mock: { calls: [unknown, { body: string }][] } }).mock.calls[0][1];
      expect(JSON.parse(init.body).max_results).toBe(5);
    });
  });

  describe('no provider configured', () => {
    it('throws a typed WebSearchConfigError when no key is present', async () => {
      const fetchImpl = makeFetch({});
      const server = createWebSearchServer({ env: {}, fetchImpl });

      expect(server.activeProvider()).toBeNull();
      await expect(server.call({ query: 'q' })).rejects.toBeInstanceOf(WebSearchConfigError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('the config error carries a stable code and no brand names', async () => {
      const server = createWebSearchServer({ env: {}, fetchImpl: makeFetch({}) });
      try {
        await server.call({ query: 'q' });
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(WebSearchConfigError);
        const err = error as WebSearchConfigError;
        expect(err.code).toBe('no_provider_configured');
        expect(err.message).not.toMatch(/tavily|brave|exa/i);
      }
    });
  });

  describe('empty / invalid input', () => {
    it('returns a message for an empty query without calling fetch', async () => {
      const fetchImpl = makeFetch({});
      const server = createWebSearchServer({ env: { [TAVILY_ENV]: 'k' }, fetchImpl });

      const res = await server.call({ query: '   ' });
      expect(res.results).toHaveLength(0);
      expect(res.message).toBeTruthy();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns a message when the provider yields zero results', async () => {
      const fetchImpl = makeFetch({ results: [] });
      const server = createWebSearchServer({ env: { [TAVILY_ENV]: 'k' }, fetchImpl });

      const res = await server.call({ query: 'nothing' });
      expect(res.results).toHaveLength(0);
      expect(res.message).toContain('nothing');
    });
  });

  describe('provider HTTP failure', () => {
    it('throws a provider-agnostic error on a non-OK response (no brand, no key)', async () => {
      const fetchImpl = makeFetch({}, { ok: false, status: 401 });
      const server = createWebSearchServer({ env: { [TAVILY_ENV]: 'secret-key' }, fetchImpl });

      await expect(server.call({ query: 'q' })).rejects.toThrow(/HTTP 401/);
      await expect(server.call({ query: 'q' })).rejects.not.toThrow(/secret-key|tavily/i);
    });
  });
});
