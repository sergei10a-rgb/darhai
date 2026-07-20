/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `resilientFetch`. `fetch` is mocked and `Math.random` is pinned
 * so `ApiKeyManager` starts at the first key deterministically; we then assert
 * the rotation, exhaustion, non-retryable, happy-path, and multi-key-split
 * behaviours - proving key rotation is reused from `ApiKeyManager`, not rebuilt.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resilientFetch, type ResilientFetchParams } from '@process/services/completion/resilientFetch';
import type { IProvider } from '@/common/config/storage';
import { resetProviderCircuits, resetModelLockouts } from '@process/services/resilience';

type MockRes = { ok: boolean; status: number; json: () => Promise<unknown> };

const res = (status: number): MockRes => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ error: { message: `status ${status}` } }),
});

const bearerOf = (init: RequestInit): string => {
  const auth = (init.headers as Record<string, string>).Authorization ?? '';
  return auth.replace('Bearer ', '');
};

/** Records which key each attempt used. */
let keysUsed: string[];

const provider = (apiKey: string): IProvider => ({
  id: 'openai',
  platform: 'openai',
  name: 'OpenAI',
  baseUrl: '',
  apiKey,
  model: ['gpt-4o-mini'],
});

const params = (apiKey: string, overrides: Partial<ResilientFetchParams> = {}): ResilientFetchParams => ({
  provider: provider(apiKey),
  modelId: 'gpt-4o-mini',
  flavor: 'openai',
  retryDelayMs: 0,
  buildRequest: (key) => ({
    url: 'https://api.test/v1/chat/completions',
    init: { method: 'POST', headers: { Authorization: `Bearer ${key}` } },
  }),
  ...overrides,
});

beforeEach(() => {
  resetProviderCircuits();
  resetModelLockouts();
  keysUsed = [];
  vi.spyOn(Math, 'random').mockReturnValue(0); // ApiKeyManager starts at key #1
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resilientFetch', () => {
  it('happy path: a single valid key makes exactly one fetch call', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      keysUsed.push(bearerOf(init));
      return res(200) as unknown as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await resilientFetch(params('only-key'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(keysUsed).toEqual(['only-key']);
    expect(out.status).toBe(200);
  });

  it('rotates from key #1 to key #2 on a retryable 429 and succeeds', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      keysUsed.push(bearerOf(init));
      call += 1;
      return (call === 1 ? res(429) : res(200)) as unknown as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await resilientFetch(params('k1,k2'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keysUsed).toEqual(['k1', 'k2']); // rotated to the second key
    expect(out.status).toBe(200);
  });

  it('throws the last error once every key is exhausted', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      keysUsed.push(bearerOf(init));
      return res(429) as unknown as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(resilientFetch(params('k1,k2'))).rejects.toThrow('429');
    expect(fetchMock).toHaveBeenCalledTimes(2); // both keys tried, then throw
    expect(keysUsed).toEqual(['k1', 'k2']);
  });

  it('does NOT rotate on a non-retryable 400 and returns the response', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      keysUsed.push(bearerOf(init));
      return res(400) as unknown as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await resilientFetch(params('k1,k2'));

    expect(fetchMock).toHaveBeenCalledTimes(1); // no rotation
    expect(keysUsed).toEqual(['k1']);
    expect(out.status).toBe(400); // caller parses + throws as before
  });

  it('splits a multi-key string on both commas and newlines (parseKeys)', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      keysUsed.push(bearerOf(init));
      return res(429) as unknown as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(resilientFetch(params('k1,k2\nk3'))).rejects.toThrow('429');
    expect(keysUsed).toEqual(['k1', 'k2', 'k3']); // three distinct keys => string was split
  });
});
