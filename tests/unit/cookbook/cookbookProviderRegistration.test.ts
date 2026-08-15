/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  COOKBOOK_LOCAL_ID,
  markCookbookServeStoppedInRepo,
  registerCookbookServeInRepo,
  type CookbookRegistryRepo,
} from '@process/services/cookbook/cookbookProviderRegistration';

const makeRepo = (existing = false) => {
  const calls = {
    upsert: vi.fn(),
    updateState: vi.fn(),
    replaceCatalog: vi.fn(),
  };
  const repo: CookbookRegistryRepo = {
    getRegistryProvider: vi.fn(() => (existing ? { state: 'connected' } : null)),
    upsertRegistryProvider: calls.upsert,
    updateRegistryProviderState: calls.updateState,
    replaceRegistryCatalog: calls.replaceCatalog,
  };
  return { repo, calls };
};

describe('registerCookbookServeInRepo', () => {
  it('upserts a keyless loopback provider + a one-model catalog', () => {
    const { repo, calls } = makeRepo();
    const ok = registerCookbookServeInRepo(repo, {
      port: 51234,
      servedModelId: 'org/Model',
      displayName: 'org/Model',
    });
    expect(ok).toBe(true);
    expect(calls.upsert).toHaveBeenCalledWith({
      providerId: COOKBOOK_LOCAL_ID,
      connectedVia: 'cookbook-serve',
      state: 'connected',
      creds: { key: '', baseUrl: 'http://127.0.0.1:51234/v1' },
    });
    expect(calls.replaceCatalog).toHaveBeenCalledTimes(1);
    const [pid, models] = calls.replaceCatalog.mock.calls[0];
    expect(pid).toBe(COOKBOOK_LOCAL_ID);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'org/Model',
      providerId: COOKBOOK_LOCAL_ID,
      kind: 'text',
      enriched: false,
    });
  });

  it('registers an explicit base URL verbatim, overriding the port derivation', () => {
    // LM Studio: Darhai never allocated the port, so the URL is passed in
    // rather than derived from one. The two are given DIFFERENT ports here on
    // purpose - LM Studio's default happens to derive to the same string, so a
    // same-port case could not tell an honoured `baseUrl` from an ignored one.
    const { repo, calls } = makeRepo();
    registerCookbookServeInRepo(repo, {
      port: 1234,
      servedModelId: 'qwen/qwen3.6-27b',
      displayName: 'qwen/qwen3.6-27b',
      baseUrl: 'http://127.0.0.1:4321/v1',
    });
    expect(calls.upsert.mock.calls[0][0].creds).toEqual({ key: '', baseUrl: 'http://127.0.0.1:4321/v1' });
    expect(calls.replaceCatalog.mock.calls[0][1][0].id).toBe('qwen/qwen3.6-27b');
  });

  it('is idempotent - a re-serve upserts again with the new port', () => {
    const { repo, calls } = makeRepo(true);
    registerCookbookServeInRepo(repo, { port: 8080, servedModelId: 'm', displayName: 'm' });
    registerCookbookServeInRepo(repo, { port: 9090, servedModelId: 'm', displayName: 'm' });
    expect(calls.upsert).toHaveBeenCalledTimes(2);
    expect(calls.upsert.mock.calls[1][0].creds.baseUrl).toBe('http://127.0.0.1:9090/v1');
  });

  it('never throws - a repo error degrades to false', () => {
    const repo: CookbookRegistryRepo = {
      getRegistryProvider: () => null,
      upsertRegistryProvider: () => {
        throw new Error('db down');
      },
      updateRegistryProviderState: vi.fn(),
      replaceRegistryCatalog: vi.fn(),
    };
    expect(registerCookbookServeInRepo(repo, { port: 1, servedModelId: 'm', displayName: 'm' })).toBe(false);
  });
});

describe('markCookbookServeStoppedInRepo', () => {
  it('flips the provider to error/offline when it exists', () => {
    const { repo, calls } = makeRepo(true);
    markCookbookServeStoppedInRepo(repo);
    expect(calls.updateState).toHaveBeenCalledWith(COOKBOOK_LOCAL_ID, 'error', 'offline');
  });

  it('is a no-op when the provider was never registered', () => {
    const { repo, calls } = makeRepo(false);
    markCookbookServeStoppedInRepo(repo);
    expect(calls.updateState).not.toHaveBeenCalled();
  });
});
