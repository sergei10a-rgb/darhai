/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the credential store maps subscription ids onto the
 * `subscription:<id>` registry namespace, round-trips tokens through the
 * repository, and validates decrypted records. A fake in-memory repository
 * stands in for `ProviderRepository` so the encryption/DB path is exercised by
 * its own tests, not re-mocked here.
 */

import { describe, it, expect } from 'vitest';
import type { ProviderRepository } from '@process/providers/storage/ProviderRepository';
import {
  ProviderRepositoryCredStore,
  coerceCredentials,
} from '@process/services/completion/subscriptionOAuth/tokenStore';
import type { OAuthCredentials } from '@process/services/completion/subscriptionOAuth/types';

/** Minimal fake exposing just the three repo methods the store calls. */
function fakeRepo() {
  const rows = new Map<string, Record<string, unknown>>();
  const upsertCalls: string[] = [];
  const repo = {
    upsertRegistryProvider(params: { providerId: string; creds: Record<string, unknown> }) {
      upsertCalls.push(params.providerId);
      rows.set(params.providerId, params.creds);
    },
    getRegistryProviderCreds(providerId: string) {
      const creds = rows.get(providerId);
      return creds ? { status: 'ok' as const, creds } : { status: 'not-found' as const };
    },
    deleteRegistryProvider(providerId: string) {
      rows.delete(providerId);
    },
  };
  return { repo: repo as unknown as ProviderRepository, rows, upsertCalls };
}

const creds: OAuthCredentials = { access: 'access-tok', refresh: 'refresh-tok', expires: 123, accountId: 'acc_1' };

describe('coerceCredentials', () => {
  it('accepts a well-formed record and preserves extra fields', () => {
    expect(coerceCredentials({ ...creds })).toEqual(creds);
  });

  it('rejects records missing required token fields', () => {
    expect(coerceCredentials({ access: 'x', refresh: 'y' })).toBeUndefined(); // no expires
    expect(coerceCredentials({ access: '', refresh: 'y', expires: 1 })).toBeUndefined(); // empty access
    expect(coerceCredentials({ access: 'x', refresh: 'y', expires: 'soon' })).toBeUndefined(); // wrong type
    expect(coerceCredentials({})).toBeUndefined();
  });
});

describe('ProviderRepositoryCredStore', () => {
  it('writes under the subscription:<id> namespace', () => {
    const { repo, upsertCalls } = fakeRepo();
    const store = new ProviderRepositoryCredStore(repo);

    store.write('anthropic-max', creds);

    expect(upsertCalls).toEqual(['subscription:anthropic-max']);
  });

  it('round-trips credentials write -> read', () => {
    const { repo } = fakeRepo();
    const store = new ProviderRepositoryCredStore(repo);

    expect(store.read('chatgpt')).toBeUndefined();
    store.write('chatgpt', creds);
    expect(store.read('chatgpt')).toEqual(creds);
  });

  it('clear removes the stored row', () => {
    const { repo } = fakeRepo();
    const store = new ProviderRepositoryCredStore(repo);
    store.write('github-copilot', creds);

    store.clear('github-copilot');

    expect(store.read('github-copilot')).toBeUndefined();
  });

  it('returns undefined for an undecryptable/corrupt row', () => {
    const { repo, rows } = fakeRepo();
    const store = new ProviderRepositoryCredStore(repo);
    rows.set('subscription:anthropic-max', { access: 'x' }); // missing refresh/expires

    expect(store.read('anthropic-max')).toBeUndefined();
  });
});
