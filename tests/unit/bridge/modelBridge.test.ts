/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Handler = (...args: unknown[]) => unknown | Promise<unknown>;

type FetchModelListArgs = {
  base_url?: string;
  api_key: string;
  try_fix?: boolean;
  platform?: string;
};

type FetchModelListResponse = {
  success: boolean;
  msg?: string;
  data?: { mode: Array<string | { id: string; name: string }>; fix_base_url?: string };
};

const { handlers, mockModelsList, mockDnsLookup } = vi.hoisted(() => {
  return {
    handlers: {} as Record<string, Handler>,
    mockModelsList: vi.fn(),
    mockDnsLookup: vi.fn(),
  };
});

function makeChannel(name: string) {
  return {
    provider: vi.fn((fn: Handler) => {
      handlers[name] = fn;
    }),
    emit: vi.fn(),
    invoke: vi.fn(),
  };
}

vi.mock('@/common', () => ({
  ipcBridge: {
    mode: {
      fetchModelList: makeChannel('fetchModelList'),
      saveModelConfig: makeChannel('saveModelConfig'),
      getModelConfig: makeChannel('getModelConfig'),
      detectProtocol: makeChannel('detectProtocol'),
    },
  },
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor(config: { apiKey?: string }) {
      // Simulate real OpenAI SDK behavior: throw when apiKey is undefined or whitespace-only
      const key = config.apiKey;
      if (key === undefined || key.trim() === '') {
        throw new Error(
          'Missing credentials. Please pass an `apiKey`, or set the `OPENAI_API_KEY` environment variable.'
        );
      }
    }

    models = {
      list: mockModelsList,
    };
  },
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: {
    set: vi.fn(async () => undefined),
    get: vi.fn(async () => []),
  },
}));

vi.mock('@process/extensions', () => ({
  ExtensionRegistry: {
    getInstance: vi.fn(() => ({
      getModelProviders: vi.fn(() => []),
    })),
  },
}));

vi.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: function MockBedrockClient() {},
  ListInferenceProfilesCommand: function MockListInferenceProfilesCommand() {},
}));

// The SSRF guard resolves non-literal hostnames (DNS-rebinding defense). Mock
// it so these tests never hit the network; default to a benign public address.
vi.mock('node:dns', () => ({
  promises: {
    lookup: mockDnsLookup,
  },
}));

import { initModelBridge } from '../../../src/process/bridge/model/modelBridge';

function getFetchModelListHandler() {
  const handler = handlers.fetchModelList;
  expect(handler).toBeTypeOf('function');
  return handler as (args: FetchModelListArgs) => Promise<FetchModelListResponse>;
}

describe('modelBridge fetchModelList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModelsList.mockReset();
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    initModelBridge();
  });

  it('returns the MiniMax hardcoded list including MiniMax-M2.7 and MiniMax-M2.5', async () => {
    const fetchModelList = getFetchModelListHandler();

    const result = await fetchModelList({
      base_url: 'https://api.minimaxi.com/v1',
      api_key: 'minimax-key',
    });

    expect(result).toEqual({
      success: true,
      data: {
        mode: ['MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2.1-lightning', 'MiniMax-M2', 'M2-her'],
      },
    });
    expect(mockModelsList).not.toHaveBeenCalled();
  });

  it('returns error when apiKey is empty for new-api platform (Fixes ELECTRON-6X)', async () => {
    const fetchModelList = getFetchModelListHandler();

    const result = await fetchModelList({
      base_url: 'https://new-api.example.com',
      api_key: '',
      platform: 'new-api',
    });

    expect(result.success).toBe(false);
    expect(result.msg).toContain('API key is required');
    expect(mockModelsList).not.toHaveBeenCalled();
  });

  it('returns error when apiKey is undefined for new-api platform (Fixes ELECTRON-6X)', async () => {
    const fetchModelList = getFetchModelListHandler();

    const result = await fetchModelList({
      base_url: 'https://new-api.example.com',
      api_key: undefined as unknown as string,
      platform: 'new-api',
    });

    expect(result.success).toBe(false);
    expect(result.msg).toContain('API key is required');
    expect(mockModelsList).not.toHaveBeenCalled();
  });

  it('returns error when apiKey is whitespace-only for new-api platform (Fixes ELECTRON-6X)', async () => {
    const fetchModelList = getFetchModelListHandler();

    const result = await fetchModelList({
      base_url: 'https://new-api.example.com',
      api_key: '   ',
      platform: 'new-api',
    });

    expect(result.success).toBe(false);
    expect(result.msg).toContain('API key is required');
    expect(mockModelsList).not.toHaveBeenCalled();
  });

  it('returns error when apiKey is whitespace-only for default OpenAI path (Fixes ELECTRON-6X)', async () => {
    const fetchModelList = getFetchModelListHandler();

    const result = await fetchModelList({
      base_url: 'https://api.openai.com/v1',
      api_key: ' \t\n ',
      try_fix: false,
    });

    expect(result.success).toBe(false);
    expect(result.msg).toContain('API key is required');
    expect(mockModelsList).not.toHaveBeenCalled();
  });

  it('catches OpenAI constructor errors instead of unhandled rejection (Fixes ELECTRON-6X)', async () => {
    const fetchModelList = getFetchModelListHandler();

    // Even if apiKey somehow passes the guard, the constructor error should be caught
    const result = await fetchModelList({
      base_url: 'https://api.openai.com/v1',
      api_key: undefined as unknown as string,
      try_fix: false,
    });

    expect(result.success).toBe(false);
    expect(mockModelsList).not.toHaveBeenCalled();
  });

  it('returns the OpenAI-compatible result for non-MiniMax URLs', async () => {
    mockModelsList.mockResolvedValue({
      data: [{ id: 'gpt-4o-mini' }],
    });

    const fetchModelList = getFetchModelListHandler();
    const result = await fetchModelList({
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test',
      try_fix: false,
    });

    expect(mockModelsList).toHaveBeenCalledOnce();
    expect(result).toEqual({
      success: true,
      data: {
        mode: ['gpt-4o-mini'],
      },
    });
  });

  it('returns an error when a non-MiniMax OpenAI-compatible provider fails', async () => {
    mockModelsList.mockRejectedValue(new Error('upstream unavailable'));

    const fetchModelList = getFetchModelListHandler();
    const result = await fetchModelList({
      base_url: 'https://example.com/v1',
      api_key: 'sk-test',
      try_fix: false,
    });

    expect(mockModelsList).toHaveBeenCalledOnce();
    expect(result).toEqual({
      success: false,
      msg: 'upstream unavailable',
    });
  });

  // ── Keyless local backends (Ollama / LM Studio / llama.cpp) ──────────────
  it('lists models for a LOCAL endpoint with an empty key (placeholder injected)', async () => {
    mockModelsList.mockResolvedValue({ data: [{ id: 'llama3:latest' }, { id: 'qwen2.5:7b' }] });

    const fetchModelList = getFetchModelListHandler();
    const result = await fetchModelList({
      base_url: 'http://127.0.0.1:11434/v1',
      api_key: '',
      try_fix: false,
    });

    // The OpenAI mock throws on an empty/whitespace key; reaching models.list()
    // proves a non-empty placeholder was injected for the local host.
    expect(mockModelsList).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true, data: { mode: ['llama3:latest', 'qwen2.5:7b'] } });
  });

  it('lists models for a localhost endpoint with no key (LM Studio style)', async () => {
    mockModelsList.mockResolvedValue({ data: [{ id: 'local-model' }] });

    const fetchModelList = getFetchModelListHandler();
    const result = await fetchModelList({
      base_url: 'http://localhost:1234/v1',
      api_key: undefined as unknown as string,
      try_fix: false,
    });

    expect(result).toEqual({ success: true, data: { mode: ['local-model'] } });
  });

  it('STILL errors for a CLOUD endpoint with an empty key (no keyless regression)', async () => {
    const fetchModelList = getFetchModelListHandler();
    const result = await fetchModelList({
      base_url: 'https://api.openai.com/v1',
      api_key: '',
      try_fix: false,
    });

    expect(result.success).toBe(false);
    expect(result.msg).toContain('API key is required');
    expect(mockModelsList).not.toHaveBeenCalled();
  });

  it('lists models for a LOCAL new-api endpoint with an empty key', async () => {
    mockModelsList.mockResolvedValue({ data: [{ id: 'local-1' }] });

    const fetchModelList = getFetchModelListHandler();
    const result = await fetchModelList({
      base_url: 'http://127.0.0.1:11434',
      api_key: '',
      platform: 'new-api',
    });

    expect(mockModelsList).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true, data: { mode: ['local-1'] } });
  });

  // ── DashScope Coding Plan: live /v1/models with a network-only fallback ──
  describe('DashScope Coding Plan', () => {
    const DS_BASE = 'https://coding.dashscope.aliyuncs.com/v1';
    const mockFetch = vi.fn();

    beforeEach(() => {
      mockFetch.mockReset();
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns the LIVE /v1/models list, not a hardcoded snapshot', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'qwen3.7-plus' }, { id: 'qwen-live-sentinel' }] }),
      });

      const fetchModelList = getFetchModelListHandler();
      const result = await fetchModelList({ base_url: DS_BASE, api_key: 'ds-key' });

      // The sentinel id only exists in the mocked live response - a fix that
      // kept returning the static list could never produce it.
      expect(result).toEqual({ success: true, data: { mode: ['qwen3.7-plus', 'qwen-live-sentinel'] } });
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(url).toBe('https://coding.dashscope.aliyuncs.com/v1/models');
      expect(init.headers.Authorization).toBe('Bearer ds-key');
    });

    it('surfaces a 401 as a failed key check instead of masking it with the fallback', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'bad key' } }),
      });

      const result = await getFetchModelListHandler()({ base_url: DS_BASE, api_key: 'expired' });

      expect(result).toEqual({ success: false, msg: 'bad key' });
    });

    it('falls back to the refreshed static snapshot ONLY on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('offline'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await getFetchModelListHandler()({ base_url: DS_BASE, api_key: 'ds-key' });

      expect(result.success).toBe(true);
      // The snapshot must be the REFRESHED one - the stale 8-row list carried
      // neither qwen3.7-plus nor qwen3.6-plus.
      expect(result.data?.mode).toContain('qwen3.7-plus');
      expect(result.data?.mode).toContain('qwen3.6-plus');
      warnSpy.mockRestore();
    });

    it('runs the SSRF guard even when no API key is set', async () => {
      // The old code only validated the URL inside `if (actualApiKey)`, so a
      // keyless entry skipped SSRF entirely.
      mockDnsLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

      const result = await getFetchModelListHandler()({ base_url: DS_BASE, api_key: '' });

      expect(result.success).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
