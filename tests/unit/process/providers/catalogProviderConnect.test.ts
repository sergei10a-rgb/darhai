/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression tests for the two provider-connect defects the functional audit
 * found.
 *
 * 1. CRITICAL - 99 of the 100 catalog providers could not be connected. The
 *    Browse catalog view sends key-only creds (the provider is already known, so
 *    the user is never asked for a URL) and `resolveCreds` never consulted the
 *    vendored catalog, so the connection test had no endpoint to talk to. It
 *    failed in single-digit milliseconds with `{ok:false,error:'unknown'}` and
 *    NO network attempt at all. The assertions below pin the endpoint the
 *    connect path hands to the connection tester, per provider, so a regression
 *    shows up as "no baseUrl / wrong baseUrl" rather than as a mystery timeout.
 *
 * 2. MEDIUM - a provider whose only probe is a PUBLIC `/v1/models` endpoint was
 *    persisted as `connected` for a garbage key. The tester now reports such a
 *    success as `unverified`, and the registry must persist that verbatim
 *    instead of laundering it into a green `connected` row.
 */

import { describe, expect, it, vi } from 'vitest';

// `ProviderRepository` encrypts creds through Electron `safeStorage`, which does
// not exist under Vitest. These tests use an in-memory repo fake, but the module
// graph still imports the repository, so the stub has to be in place.
const { mockSafeStorage } = vi.hoisted(() => ({
  mockSafeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((plaintext: string) => Buffer.from(`enc(${plaintext})`)),
    decryptString: vi.fn((cipher: Buffer) => cipher.toString('utf8').replace(/^enc\((.*)\)$/s, '$1')),
  },
}));

vi.mock('electron', () => ({ safeStorage: mockSafeStorage }));

import { ConnectionTester } from '@process/providers/detection/ConnectionTester';
import { PROVIDER_ENDPOINTS } from '@process/providers/detection/providerEndpoints';
import { catalogBaseUrlFor, isCatalogProvider } from '@process/providers/catalog/catalogEndpoint';
import { loadBaselineProviderCatalog } from '@process/providers/catalog/providerCatalogStore';
import { createModelRegistryHandlers } from '@process/providers/ipc/modelRegistryIpc';
import type { ModelRegistryDeps } from '@process/providers/ipc/modelRegistryIpc';
import type { CatalogModel, ProviderId } from '@process/providers/types';
import type {
  RegistryCredsResult,
  RegistryOverride,
  RegistryProvider,
} from '@process/providers/storage/ProviderRepository';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * The catalog providers exercised end-to-end. Deliberately the SAME five the
 * audit measured failing at 3-11ms with no network attempt, so the before/after
 * comparison is like-for-like. They also span four endpoint shapes: a bare
 * `/v1` host, a routing subdomain, a non-`api.` host, and a `/compat/v1` path.
 */
const SAMPLED_CATALOG_PROVIDERS: readonly ProviderId[] = ['302ai', 'abacus', 'chutes', 'novita-ai', 'llama'];

/** A minimal in-memory stand-in for the model-registry slice of the repository. */
class FakeRepo {
  providers = new Map<ProviderId, RegistryProvider & { creds: Record<string, unknown> }>();
  catalogs = new Map<ProviderId, CatalogModel[]>();

  listRegistryProviders(): RegistryProvider[] {
    return [...this.providers.values()];
  }

  getRegistryProvider(id: ProviderId): RegistryProvider | null {
    return this.providers.get(id) ?? null;
  }

  upsertRegistryProvider(p: {
    providerId: ProviderId;
    connectedVia: string;
    state: RegistryProvider['state'];
    error?: RegistryProvider['error'];
    creds: Record<string, unknown>;
  }): void {
    const row: RegistryProvider & { creds: Record<string, unknown> } = {
      providerId: p.providerId,
      connectedVia: p.connectedVia,
      state: p.state,
      credsEncrypted: 'enc',
      creds: p.creds,
    };
    if (p.error) row.error = p.error;
    this.providers.set(p.providerId, row);
  }

  updateRegistryProviderState(
    id: ProviderId,
    state: RegistryProvider['state'],
    error?: RegistryProvider['error']
  ): void {
    const row = this.providers.get(id);
    if (!row) return;
    row.state = state;
    if (error) row.error = error;
    else delete row.error;
  }

  updateRegistryProviderCreds(id: ProviderId, creds: Record<string, unknown>): void {
    const row = this.providers.get(id);
    if (row) row.creds = creds;
  }

  updateRegistryProviderConnectedVia(id: ProviderId, connectedVia: string): void {
    const row = this.providers.get(id);
    if (row) row.connectedVia = connectedVia;
  }

  getRegistryProviderCreds(id: ProviderId): RegistryCredsResult {
    const creds = this.providers.get(id)?.creds;
    return creds ? { status: 'ok', creds } : { status: 'not-found' };
  }

  deleteRegistryProvider(id: ProviderId): void {
    this.providers.delete(id);
    this.catalogs.delete(id);
  }

  replaceRegistryCatalog(id: ProviderId, models: CatalogModel[]): void {
    this.catalogs.set(id, models);
  }

  getRegistryCatalog(id: ProviderId): CatalogModel[] {
    return this.catalogs.get(id) ?? [];
  }

  countRegistryCatalog(id: ProviderId): number {
    return (this.catalogs.get(id) ?? []).length;
  }

  setRegistryOverride(): void {}

  listRegistryOverrides(_id: ProviderId): RegistryOverride[] {
    return [];
  }
}

type Harness = {
  repo: FakeRepo;
  deps: ModelRegistryDeps;
  /** The injected connection tester spy - records `(providerId, creds, baseUrl)`. */
  test: ReturnType<typeof vi.fn>;
  /** The `(providerId, apiKey, baseUrl)` triples handed to `makeApiSource`. */
  apiSourceCalls: Array<{ providerId: ProviderId; baseUrl: string | undefined }>;
};

function makeHarness(testResult: unknown = { ok: true }): Harness {
  const repo = new FakeRepo();
  const test = vi.fn().mockResolvedValue(testResult);
  const apiSourceCalls: Harness['apiSourceCalls'] = [];

  const deps: ModelRegistryDeps = {
    repo: repo as unknown as ModelRegistryDeps['repo'],
    keyDiscovery: { scan: vi.fn().mockResolvedValue([]), readValue: vi.fn().mockReturnValue(null) },
    connectionTester: { test },
    modelsDevClient: { getRegistry: vi.fn().mockResolvedValue({}) },
    makeApiSource: (providerId, _apiKey, baseUrl) => {
      apiSourceCalls.push({ providerId, baseUrl });
      return { kind: 'api', providerId, listModels: async () => [{ id: 'model-a', providerId }] };
    },
    makeCliSource: (agentKey) => ({
      kind: 'cli',
      providerId: agentKey,
      enumerable: false,
      underlyingProviderId: 'openai',
      listModels: async () => [],
    }),
  };

  return { repo, deps, test, apiSourceCalls };
}

/** Build a `Response`-like object the ConnectionTester can read. */
function response(body: unknown, status = 200): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => text,
  } as Response;
}

// ─── Defect 1: catalog providers are connectable with a key alone ─────────────

describe('modelRegistry connect - catalog provider endpoint resolution', () => {
  it('every vendored catalog provider resolves to an absolute https endpoint', () => {
    const catalog = loadBaselineProviderCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(100);
    for (const entry of catalog) {
      const baseUrl = catalogBaseUrlFor(entry.id);
      expect(baseUrl, `no endpoint for catalog provider "${entry.id}"`).toBeTruthy();
      expect(new URL(baseUrl as string).protocol).toBe('https:');
    }
  });

  it('does not shadow a native provider - native ids are not catalog providers', () => {
    // The catalog generator drops `native-collision` rows, so a native provider
    // must keep its hand-wired endpoint and never pick one up from the catalog.
    for (const nativeId of ['openai', 'anthropic', 'google-gemini', 'groq', 'openai-compatible'] as ProviderId[]) {
      expect(isCatalogProvider(nativeId), `native "${nativeId}" leaked into the catalog`).toBe(false);
      expect(catalogBaseUrlFor(nativeId)).toBeUndefined();
    }
  });

  it.each(SAMPLED_CATALOG_PROVIDERS)(
    'connect("%s") with a key alone probes that provider\'s own endpoint',
    async (providerId) => {
      const { deps, test, repo, apiSourceCalls } = makeHarness({ ok: false, error: 'unauthorized' });
      const h = createModelRegistryHandlers(deps);
      const expected = catalogBaseUrlFor(providerId);
      expect(expected, `fixture drift: "${providerId}" is not in the vendored catalog`).toBeTruthy();

      const result = await h.connect({ providerId, creds: { key: 'sk-fake-key' } });

      // The regression: the connect path used to hand the tester `undefined` and
      // bail with `unknown` without ever reaching the network. It must now pass
      // the provider's own endpoint through as the third argument.
      expect(test).toHaveBeenCalledTimes(1);
      const [calledProvider, calledCreds, calledBaseUrl] = test.mock.calls[0] as [ProviderId, unknown, string?];
      expect(calledProvider).toBe(providerId);
      expect(calledCreds).toEqual({ key: 'sk-fake-key', baseUrl: expected });
      expect(calledBaseUrl).toBe(expected);

      // With no real key on this machine the honest outcome is the provider's
      // own 401 - NOT the endpoint-less `unknown` the defect produced.
      expect(result).toEqual({ ok: false, error: 'unauthorized' });
      expect(repo.getRegistryProvider(providerId)).toBeNull();
      expect(apiSourceCalls).toHaveLength(0);
    }
  );

  it.each(SAMPLED_CATALOG_PROVIDERS)(
    'a successful connect("%s") persists the catalog endpoint for refresh and chat-start',
    async (providerId) => {
      const { deps, repo, apiSourceCalls } = makeHarness({ ok: true });
      const h = createModelRegistryHandlers(deps);
      const expected = catalogBaseUrlFor(providerId);

      expect(await h.connect({ providerId, creds: { key: 'sk-fake-key' } })).toEqual({ ok: true });

      // Persisted alongside the key: without it the very next refresh would fail
      // with "no models endpoint registered for provider".
      expect(repo.getRegistryProvider(providerId)?.creds).toEqual({ key: 'sk-fake-key', baseUrl: expected });
      expect(apiSourceCalls).toEqual([{ providerId, baseUrl: expected }]);
      expect(repo.countRegistryCatalog(providerId)).toBe(1);
    }
  );

  it('leaves a caller-supplied baseUrl untouched', async () => {
    const { deps, test } = makeHarness({ ok: true });
    const h = createModelRegistryHandlers(deps);

    await h.connect({ providerId: '302ai', creds: { key: 'k', baseUrl: 'https://proxy.example.com/v1' } });

    expect(test.mock.calls[0][2]).toBe('https://proxy.example.com/v1');
  });

  it('gives a native provider no catalog endpoint (its own wiring stays authoritative)', async () => {
    const { deps, test } = makeHarness({ ok: true });
    const h = createModelRegistryHandlers(deps);

    await h.connect({ providerId: 'openai', creds: { key: 'sk-native' } });

    expect(test.mock.calls[0][1]).toEqual({ key: 'sk-native' });
    expect(test.mock.calls[0][2]).toBeUndefined();
  });
});

// ─── Defect 2: an unauthenticated 200 is never reported as connected ──────────

describe('ConnectionTester - a public models endpoint cannot verify a key', () => {
  it('flags a provider whose /v1/models answers the same way without the key', async () => {
    // `ollama-cloud` is the real case the audit caught: it has a registered
    // endpoint but no TEST_MODEL, so it takes the degraded auth-only branch -
    // and https://ollama.com/v1/models answers 200 to an anonymous GET.
    expect(PROVIDER_ENDPOINTS['ollama-cloud']).toBeTruthy();
    const fetchMock = vi.fn().mockResolvedValue(response({ data: [{ id: 'gpt-oss:20b' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ConnectionTester().test('ollama-cloud', { key: 'sk-darhai-audit-FAKE' });

    expect(result).toEqual({ ok: true, unverified: true });
    // Two round-trips: the credentialed probe, then the anonymous control probe
    // that carries no Authorization header at all.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const controlHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(controlHeaders.Authorization).toBeUndefined();
    expect(JSON.stringify(controlHeaders)).not.toContain('sk-darhai-audit-FAKE');

    vi.unstubAllGlobals();
  });

  it('does not flag a provider whose endpoint rejects the anonymous request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ data: [{ id: 'gpt-oss:20b' }] }))
      .mockResolvedValueOnce(response({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ConnectionTester().test('ollama-cloud', { key: 'sk-real' });

    expect(result).toEqual({ ok: true });
    vi.unstubAllGlobals();
  });

  it('skips the control probe for a keyless local backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ data: [{ id: 'llama3' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ConnectionTester().test('ollama-local', { key: '' }, 'http://127.0.0.1:11434/v1');

    // Nothing was sent, so there is nothing to verify - one request, plain ok.
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('modelRegistry connect - an unverified probe never persists as connected', () => {
  it('persists state "unverified" and surfaces it through list()', async () => {
    const { deps, repo } = makeHarness({ ok: true, unverified: true });
    const h = createModelRegistryHandlers(deps);

    const result = await h.connect({ providerId: 'ollama-cloud', creds: { key: 'sk-darhai-audit-FAKE' } });

    expect(result).toEqual({ ok: true });
    expect(repo.getRegistryProvider('ollama-cloud')?.state).toBe('unverified');
    const [view] = await h.list();
    expect(view.state).toBe('unverified');
    expect(view.state).not.toBe('connected');
  });

  it('persists state "connected" when the probe did verify the key', async () => {
    const { deps, repo } = makeHarness({ ok: true });
    const h = createModelRegistryHandlers(deps);

    await h.connect({ providerId: 'ollama-cloud', creds: { key: 'sk-real' } });

    expect(repo.getRegistryProvider('ollama-cloud')?.state).toBe('connected');
  });

  it('re-testing an unverified provider cannot launder it back to connected', async () => {
    const { deps, repo, test } = makeHarness({ ok: true });
    const h = createModelRegistryHandlers(deps);
    await h.connect({ providerId: 'ollama-cloud', creds: { key: 'sk-fake' } });
    expect(repo.getRegistryProvider('ollama-cloud')?.state).toBe('connected');

    test.mockResolvedValue({ ok: true, unverified: true });
    expect(await h.testConnection({ providerId: 'ollama-cloud' })).toEqual({ ok: true });

    expect(repo.getRegistryProvider('ollama-cloud')?.state).toBe('unverified');
  });
});
