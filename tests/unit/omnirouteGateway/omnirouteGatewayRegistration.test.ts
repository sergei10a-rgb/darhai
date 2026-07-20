/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 7b registration core: enabling the OmniRoute gateway upserts ONE
 * `omniroute-gateway` registry row (idempotent - never a duplicate), disabling
 * removes it, and the legacy mirror row carries the Mongolian relay-marked
 * display name (owner condition 2) even when the gateway runs keyless.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IProvider } from '@/common/config/storage';
import type { CatalogModel, ProviderId } from '@process/providers/types';
import { OMNIROUTE_GATEWAY_DISPLAY_NAME, OMNIROUTE_GATEWAY_PROVIDER_ID } from '@/common/types/omnirouteGateway';
import {
  deregisterOmnirouteGatewayFromRepo,
  normalizeGatewayModelIds,
  registerOmnirouteGatewayInRepo,
  type OmnirouteGatewayRegistryRepo,
} from '@process/services/omnirouteGateway/omnirouteGatewayRegistration';

// In-memory `model.config` store backing the legacy mirror's read/write.
let configStore: unknown = undefined;
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: {
    get: vi.fn(async (_key: string) => configStore),
    set: vi.fn(async (_key: string, value: unknown) => {
      configStore = value;
    }),
  },
}));

import { mirrorConnectOrRekey } from '@process/providers/legacyModelConfigBridge';
import type { ProviderRepository } from '@process/providers/storage/ProviderRepository';

const BASE_URL = 'http://localhost:20128/v1';

/** An in-memory fake of the registry slice the registration flow touches. */
function makeFakeRepo(): OmnirouteGatewayRegistryRepo & {
  rows: Map<string, { connectedVia: string; state: string; creds: Record<string, unknown> }>;
  catalogs: Map<string, CatalogModel[]>;
} {
  const rows = new Map<string, { connectedVia: string; state: string; creds: Record<string, unknown> }>();
  const catalogs = new Map<string, CatalogModel[]>();
  return {
    rows,
    catalogs,
    getRegistryProvider: (providerId: ProviderId) => {
      const row = rows.get(providerId);
      return row ? { state: row.state } : null;
    },
    upsertRegistryProvider: (params) => {
      rows.set(params.providerId, {
        connectedVia: params.connectedVia,
        state: params.state,
        creds: params.creds,
      });
    },
    replaceRegistryCatalog: (providerId, models) => {
      catalogs.set(providerId, models);
    },
    deleteRegistryProvider: (providerId) => {
      rows.delete(providerId);
      catalogs.delete(providerId);
    },
  };
}

describe('registerOmnirouteGatewayInRepo', () => {
  it('registers the gateway as a connected provider pinned to the confirmed URL', () => {
    const repo = makeFakeRepo();

    const ok = registerOmnirouteGatewayInRepo(repo, { baseUrl: BASE_URL, apiKey: 'or-key', modelIds: ['gpt-x'] });

    expect(ok).toBe(true);
    const row = repo.rows.get(OMNIROUTE_GATEWAY_PROVIDER_ID);
    expect(row).toBeDefined();
    expect(row?.state).toBe('connected');
    expect(row?.connectedVia).toBe('omniroute-gateway');
    expect(row?.creds).toEqual({ key: 'or-key', baseUrl: BASE_URL });
    expect(repo.catalogs.get(OMNIROUTE_GATEWAY_PROVIDER_ID)?.map((m) => m.id)).toEqual(['gpt-x']);
  });

  it('is idempotent: a double-enable keeps exactly one row (no duplicates)', () => {
    const repo = makeFakeRepo();

    registerOmnirouteGatewayInRepo(repo, { baseUrl: BASE_URL, apiKey: '', modelIds: ['a'] });
    registerOmnirouteGatewayInRepo(repo, { baseUrl: BASE_URL, apiKey: '', modelIds: ['a', 'b'] });

    expect(repo.rows.size).toBe(1);
    expect(repo.catalogs.get(OMNIROUTE_GATEWAY_PROVIDER_ID)?.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('normalizes gateway model ids (dedup + trims + drops empties)', () => {
    expect(normalizeGatewayModelIds(['a', ' a ', '', 'b', 'a'])).toEqual(['a', 'b']);
  });

  it('never throws when the repo fails - returns false instead', () => {
    const repo = makeFakeRepo();
    repo.upsertRegistryProvider = () => {
      throw new Error('db down');
    };
    expect(registerOmnirouteGatewayInRepo(repo, { baseUrl: BASE_URL, apiKey: '', modelIds: [] })).toBe(false);
  });
});

describe('deregisterOmnirouteGatewayFromRepo', () => {
  it('removes the provider row and catalog on disable', () => {
    const repo = makeFakeRepo();
    registerOmnirouteGatewayInRepo(repo, { baseUrl: BASE_URL, apiKey: '', modelIds: ['a'] });

    expect(deregisterOmnirouteGatewayFromRepo(repo)).toBe(true);
    expect(repo.rows.size).toBe(0);
    expect(repo.catalogs.size).toBe(0);
  });

  it('is a no-op when the gateway was never registered', () => {
    const repo = makeFakeRepo();
    expect(deregisterOmnirouteGatewayFromRepo(repo)).toBe(true);
    expect(repo.rows.size).toBe(0);
  });
});

describe('legacy mirror - relay-marked display name (owner condition 2)', () => {
  beforeEach(() => {
    configStore = undefined;
    vi.clearAllMocks();
  });

  /** Repo fake exposing exactly what `mirrorConnectOrRekey` reads. */
  function makeMirrorRepo(apiKey: string): ProviderRepository {
    const model: CatalogModel = {
      id: 'gpt-x',
      providerId: OMNIROUTE_GATEWAY_PROVIDER_ID,
      displayName: 'gpt-x',
      family: 'gpt-x',
      kind: 'text',
      enriched: false,
      tags: ['chat'],
    };
    return {
      getRegistryProvider: () => ({ providerId: OMNIROUTE_GATEWAY_PROVIDER_ID, state: 'connected' }) as unknown,
      getRegistryProviderCreds: () => ({ status: 'ok' as const, creds: { key: apiKey, baseUrl: BASE_URL } }),
      getRegistryCatalog: () => [model],
      listRegistryOverrides: () => [],
    } as unknown as ProviderRepository;
  }

  it('writes a legacy picker row named with the Mongolian relay marking', async () => {
    await mirrorConnectOrRekey(makeMirrorRepo('or-key'), OMNIROUTE_GATEWAY_PROVIDER_ID);

    const rows = (configStore as IProvider[]) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(OMNIROUTE_GATEWAY_DISPLAY_NAME);
    expect(rows[0].name).toContain('гадаад дамжуулагч');
    expect(rows[0].baseUrl).toBe(BASE_URL);
    expect(rows[0].model).toContain('gpt-x');
  });

  it('mirrors a KEYLESS gateway too (like ollama-local) so explicit selection works', async () => {
    await mirrorConnectOrRekey(makeMirrorRepo(''), OMNIROUTE_GATEWAY_PROVIDER_ID);

    const rows = (configStore as IProvider[]) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(OMNIROUTE_GATEWAY_DISPLAY_NAME);
    expect(rows[0].apiKey).toBe('');
  });

  it('does not duplicate the mirror row on a re-enable', async () => {
    const repo = makeMirrorRepo('or-key');
    await mirrorConnectOrRekey(repo, OMNIROUTE_GATEWAY_PROVIDER_ID);
    await mirrorConnectOrRekey(repo, OMNIROUTE_GATEWAY_PROVIDER_ID);

    const rows = ((configStore as IProvider[]) ?? []).filter((p) => p.name === OMNIROUTE_GATEWAY_DISPLAY_NAME);
    expect(rows).toHaveLength(1);
  });
});
