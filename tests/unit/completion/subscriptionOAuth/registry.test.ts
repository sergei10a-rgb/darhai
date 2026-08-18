/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The gate is enforced at the ONE entry point every login goes through. The
 * mutation proof: with the gate closed, `startSubscriptionLogin` must throw
 * BEFORE the provider's `login` runs (no port bind, no browser, no fetch) and
 * must not persist anything - asserted by the `login` spy staying at 0 calls and
 * the store staying empty. With the gate open, `login` runs once and its result
 * is written to the store. The provider flows are mocked so no real network or
 * loopback server is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startSubscriptionLogin } from '@process/services/completion/subscriptionOAuth/registry';
import { anthropicSubscriptionProvider } from '@process/services/completion/subscriptionOAuth/providers/anthropic';
import { SubscriptionLoginNotAllowedError } from '@process/services/completion/subscriptionOAuth/disclosure';
import type { SubscriptionProviderId } from '@/common/types/subscriptionOAuth';
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  SubscriptionCredStore,
} from '@process/services/completion/subscriptionOAuth/types';

vi.mock('@process/services/completion/subscriptionOAuth/providers/anthropic', () => ({
  anthropicSubscriptionProvider: {
    id: 'anthropic-max',
    name: 'Claude Max',
    login: vi.fn(),
    refreshToken: vi.fn(),
    getApiKey: vi.fn(),
  },
}));
vi.mock('@process/services/completion/subscriptionOAuth/providers/chatgpt', () => ({
  chatgptSubscriptionProvider: {
    id: 'chatgpt',
    name: 'ChatGPT',
    login: vi.fn(),
    refreshToken: vi.fn(),
    getApiKey: vi.fn(),
  },
}));
vi.mock('@process/services/completion/subscriptionOAuth/providers/githubCopilot', () => ({
  githubCopilotSubscriptionProvider: {
    id: 'github-copilot',
    name: 'Copilot',
    login: vi.fn(),
    refreshToken: vi.fn(),
    getApiKey: vi.fn(),
  },
}));

const loginSpy = vi.mocked(anthropicSubscriptionProvider.login);
const connected: OAuthCredentials = { access: 'a', refresh: 'r', expires: Date.now() + 60_000 };

const callbacks: OAuthLoginCallbacks = {
  onAuth: vi.fn(),
  onPrompt: vi.fn(async () => ''),
};

function memStore(): SubscriptionCredStore & { writes: Array<[SubscriptionProviderId, OAuthCredentials]> } {
  const writes: Array<[SubscriptionProviderId, OAuthCredentials]> = [];
  return {
    writes,
    read: () => undefined,
    write: (id, creds) => {
      writes.push([id, creds]);
    },
    clear: () => {},
  };
}

beforeEach(() => {
  loginSpy.mockReset();
});

describe('startSubscriptionLogin gate enforcement', () => {
  it('refuses and never runs the flow when the feature is disabled', async () => {
    const store = memStore();
    await expect(
      startSubscriptionLogin({
        providerId: 'anthropic-max',
        gate: { enabled: false, disclosureAcknowledged: true },
        store,
        callbacks,
      })
    ).rejects.toBeInstanceOf(SubscriptionLoginNotAllowedError);

    expect(loginSpy).toHaveBeenCalledTimes(0);
    expect(store.writes).toHaveLength(0);
  });

  it('refuses when the disclosure is not acknowledged', async () => {
    const store = memStore();
    await expect(
      startSubscriptionLogin({
        providerId: 'anthropic-max',
        gate: { enabled: true, disclosureAcknowledged: false },
        store,
        callbacks,
      })
    ).rejects.toBeInstanceOf(SubscriptionLoginNotAllowedError);

    expect(loginSpy).toHaveBeenCalledTimes(0);
    expect(store.writes).toHaveLength(0);
  });

  it('runs the flow once and persists credentials when the gate is open', async () => {
    loginSpy.mockResolvedValue(connected);
    const store = memStore();

    const result = await startSubscriptionLogin({
      providerId: 'anthropic-max',
      gate: { enabled: true, disclosureAcknowledged: true },
      store,
      callbacks,
    });

    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual(connected);
    expect(store.writes).toEqual([['anthropic-max', connected]]);
  });

  it('throws for an unknown provider id (gate open)', async () => {
    const store = memStore();
    await expect(
      startSubscriptionLogin({
        providerId: 'nope' as SubscriptionProviderId,
        gate: { enabled: true, disclosureAcknowledged: true },
        store,
        callbacks,
      })
    ).rejects.toThrow('Unknown subscription provider');
  });
});
