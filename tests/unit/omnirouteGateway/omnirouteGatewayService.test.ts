/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 7b service orchestration: apply-config keeps the registry + legacy
 * mirror in sync with the toggle, and test-connection reports reachability
 * cleanly (never throws). Config store, registry repo, and the legacy mirror
 * are all mocked - no network, no DB, no Electron.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory ProcessConfig store.
let configStore: Map<string, unknown>;
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: {
    get: vi.fn(async (key: string) => configStore.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      configStore.set(key, value);
    }),
  },
}));

const registryMocks = vi.hoisted(() => ({
  getModelRegistryRepository: vi.fn(),
}));
vi.mock('@process/providers/ipc/modelRegistryIpc', () => ({
  getModelRegistryRepository: registryMocks.getModelRegistryRepository,
}));

const mirrorMocks = vi.hoisted(() => ({
  mirrorConnectOrRekey: vi.fn(async () => undefined),
  mirrorDisconnect: vi.fn(async () => undefined),
}));
vi.mock('@process/providers/legacyModelConfigBridge', () => ({
  mirrorConnectOrRekey: mirrorMocks.mirrorConnectOrRekey,
  mirrorDisconnect: mirrorMocks.mirrorDisconnect,
}));

import { OMNIROUTE_GATEWAY_PROVIDER_ID } from '@/common/types/omnirouteGateway';
import {
  applyOmnirouteGatewayConfig,
  fetchGatewayModels,
  getOmnirouteGatewayConfigView,
  testOmnirouteGatewayConnection,
} from '@process/services/omnirouteGateway/omnirouteGatewayService';

const BASE_URL = 'http://localhost:20128/v1';

/** OpenAI-compatible `/models` payload fetch mock. */
function reachableFetch(modelIds: string[]): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: modelIds.map((id) => ({ id })) }),
  })) as unknown as typeof fetch;
}

function unreachableFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
}

type FakeRepo = {
  getRegistryProvider: ReturnType<typeof vi.fn>;
  upsertRegistryProvider: ReturnType<typeof vi.fn>;
  replaceRegistryCatalog: ReturnType<typeof vi.fn>;
  deleteRegistryProvider: ReturnType<typeof vi.fn>;
};

function makeFakeRepo(hasRow: boolean): FakeRepo {
  return {
    getRegistryProvider: vi.fn(() => (hasRow ? { state: 'connected' } : null)),
    upsertRegistryProvider: vi.fn(),
    replaceRegistryCatalog: vi.fn(),
    deleteRegistryProvider: vi.fn(),
  };
}

beforeEach(() => {
  configStore = new Map();
  registryMocks.getModelRegistryRepository.mockReset();
  mirrorMocks.mirrorConnectOrRekey.mockClear();
  mirrorMocks.mirrorDisconnect.mockClear();
});

describe('getOmnirouteGatewayConfigView', () => {
  it('defaults to DISABLED with the local prefill URL (owner condition 1)', async () => {
    const view = await getOmnirouteGatewayConfigView();
    expect(view).toEqual({ enabled: false, baseUrl: BASE_URL, hasApiKey: false });
  });

  it('never discloses the stored API key - only hasApiKey', async () => {
    configStore.set('omnirouteGateway.apiKey', 'secret-key');
    const view = await getOmnirouteGatewayConfigView();
    expect(view.hasApiKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('secret-key');
  });
});

describe('applyOmnirouteGatewayConfig', () => {
  it('enable registers the provider + catalog and mirrors into the legacy pickers', async () => {
    const repo = makeFakeRepo(false);
    registryMocks.getModelRegistryRepository.mockReturnValue(repo);

    const result = await applyOmnirouteGatewayConfig(
      { enabled: true, baseUrl: BASE_URL, apiKey: 'or-key' },
      reachableFetch(['m1', 'm2'])
    );

    expect(result.ok).toBe(true);
    expect(configStore.get('omnirouteGateway.enabled')).toBe(true);
    expect(repo.upsertRegistryProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: OMNIROUTE_GATEWAY_PROVIDER_ID,
        state: 'connected',
        creds: { key: 'or-key', baseUrl: BASE_URL },
      })
    );
    const catalog = repo.replaceRegistryCatalog.mock.calls[0][1] as Array<{ id: string }>;
    expect(catalog.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(mirrorMocks.mirrorConnectOrRekey).toHaveBeenCalledWith(repo, OMNIROUTE_GATEWAY_PROVIDER_ID);
  });

  it('enable still registers (empty catalog) when the gateway is not up yet', async () => {
    const repo = makeFakeRepo(false);
    registryMocks.getModelRegistryRepository.mockReturnValue(repo);

    const result = await applyOmnirouteGatewayConfig({ enabled: true, baseUrl: BASE_URL }, unreachableFetch());

    expect(result.ok).toBe(true);
    expect(repo.upsertRegistryProvider).toHaveBeenCalled();
    expect(repo.replaceRegistryCatalog.mock.calls[0][1]).toEqual([]);
  });

  it('disable deregisters the provider and removes the legacy mirror row', async () => {
    const repo = makeFakeRepo(true);
    registryMocks.getModelRegistryRepository.mockReturnValue(repo);

    const result = await applyOmnirouteGatewayConfig({ enabled: false, baseUrl: BASE_URL }, reachableFetch(['m1']));

    expect(result.ok).toBe(true);
    expect(configStore.get('omnirouteGateway.enabled')).toBe(false);
    expect(repo.deleteRegistryProvider).toHaveBeenCalledWith(OMNIROUTE_GATEWAY_PROVIDER_ID);
    expect(mirrorMocks.mirrorDisconnect).toHaveBeenCalledWith(OMNIROUTE_GATEWAY_PROVIDER_ID);
    // Disable must never fetch the gateway.
    expect(repo.upsertRegistryProvider).not.toHaveBeenCalled();
  });

  it('rejects a non-URL base address without touching the registry', async () => {
    const repo = makeFakeRepo(false);
    registryMocks.getModelRegistryRepository.mockReturnValue(repo);

    const result = await applyOmnirouteGatewayConfig({ enabled: true, baseUrl: 'not a url' }, reachableFetch([]));

    expect(result).toEqual({ ok: false, error: 'invalid-base-url' });
    expect(repo.upsertRegistryProvider).not.toHaveBeenCalled();
    expect(configStore.has('omnirouteGateway.enabled')).toBe(false);
  });

  it('undefined apiKey keeps the stored key; an empty string clears it', async () => {
    const repo = makeFakeRepo(false);
    registryMocks.getModelRegistryRepository.mockReturnValue(repo);
    configStore.set('omnirouteGateway.apiKey', 'stored-key');

    await applyOmnirouteGatewayConfig({ enabled: true, baseUrl: BASE_URL }, reachableFetch([]));
    expect(configStore.get('omnirouteGateway.apiKey')).toBe('stored-key');

    await applyOmnirouteGatewayConfig({ enabled: true, baseUrl: BASE_URL, apiKey: '' }, reachableFetch([]));
    expect(configStore.get('omnirouteGateway.apiKey')).toBe('');
  });
});

describe('testOmnirouteGatewayConnection', () => {
  it('reachable gateway reports ok + model count', async () => {
    const result = await testOmnirouteGatewayConnection(BASE_URL, undefined, reachableFetch(['a', 'b', 'c']));
    expect(result).toEqual({ ok: true, modelCount: 3 });
  });

  it('unreachable gateway reports a clean error (no throw)', async () => {
    const result = await testOmnirouteGatewayConnection(BASE_URL, undefined, unreachableFetch());
    expect(result).toEqual({ ok: false, error: 'unreachable' });
  });

  it('a non-URL reports invalid-base-url without fetching', async () => {
    const fetchImpl = reachableFetch([]);
    const result = await testOmnirouteGatewayConnection('nope', undefined, fetchImpl);
    expect(result).toEqual({ ok: false, error: 'invalid-base-url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a non-2xx answer surfaces the status token', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const result = await fetchGatewayModels(BASE_URL, '', fetchImpl);
    expect(result).toEqual({ ok: false, error: 'http-401' });
  });
});
