/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the use-time key resolution: a fresh token is returned WITHOUT a
 * refresh, an expired token IS refreshed and the new credentials persisted, an
 * unconnected provider yields `null`, and an unknown id throws. The provider
 * registry is mocked so `refreshToken` is a spy - the mutation proof is that its
 * call count is exactly 0 for a fresh token and 1 for an expired one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSubscriptionApiKey } from '@process/services/completion/subscriptionOAuth/getSubscriptionApiKey';
import { getSubscriptionOAuthProvider } from '@process/services/completion/subscriptionOAuth/registry';
import type {
  OAuthCredentials,
  SubscriptionCredStore,
  SubscriptionOAuthProvider,
} from '@process/services/completion/subscriptionOAuth/types';

vi.mock('@process/services/completion/subscriptionOAuth/registry', () => ({
  getSubscriptionOAuthProvider: vi.fn(),
}));

const mockedGetProvider = vi.mocked(getSubscriptionOAuthProvider);

function memStore(initial?: OAuthCredentials): SubscriptionCredStore & { writes: OAuthCredentials[] } {
  let current = initial;
  const writes: OAuthCredentials[] = [];
  return {
    writes,
    read: () => current,
    write: (_id, creds) => {
      current = creds;
      writes.push(creds);
    },
    clear: () => {
      current = undefined;
    },
  };
}

function fakeProvider(overrides?: Partial<SubscriptionOAuthProvider>): SubscriptionOAuthProvider {
  return {
    id: 'anthropic-max',
    name: 'Claude Max / Pro',
    login: vi.fn(),
    refreshToken: vi.fn(async (c: OAuthCredentials) => ({
      ...c,
      access: 'refreshed-access',
      expires: Date.now() + 3_600_000,
    })),
    getApiKey: (c: OAuthCredentials) => c.access,
    ...overrides,
  };
}

beforeEach(() => {
  mockedGetProvider.mockReset();
});

describe('getSubscriptionApiKey', () => {
  it('returns null when the provider is not connected', async () => {
    mockedGetProvider.mockReturnValue(fakeProvider());
    const result = await getSubscriptionApiKey('anthropic-max', memStore(undefined));
    expect(result).toBeNull();
  });

  it('returns a fresh token without refreshing', async () => {
    const provider = fakeProvider();
    mockedGetProvider.mockReturnValue(provider);
    const store = memStore({ access: 'live-access', refresh: 'r', expires: Date.now() + 60_000 });

    const result = await getSubscriptionApiKey('anthropic-max', store);

    expect(result?.apiKey).toBe('live-access');
    expect(provider.refreshToken).toHaveBeenCalledTimes(0);
    expect(store.writes).toHaveLength(0);
  });

  it('refreshes and persists an expired token', async () => {
    const provider = fakeProvider();
    mockedGetProvider.mockReturnValue(provider);
    const store = memStore({ access: 'stale-access', refresh: 'r', expires: Date.now() - 1 });

    const result = await getSubscriptionApiKey('anthropic-max', store);

    expect(provider.refreshToken).toHaveBeenCalledTimes(1);
    expect(result?.apiKey).toBe('refreshed-access');
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].access).toBe('refreshed-access');
  });

  it('throws for an unknown provider id', async () => {
    mockedGetProvider.mockReturnValue(undefined);
    const store = memStore({ access: 'a', refresh: 'r', expires: Date.now() + 1000 });

    await expect(getSubscriptionApiKey('anthropic-max', store)).rejects.toThrow('Unknown subscription provider');
  });
});
