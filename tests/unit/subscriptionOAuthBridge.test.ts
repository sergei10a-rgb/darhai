/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// Unit tests for subscriptionOAuthBridge - the IPC trust boundary of the
// "sign in with a subscription" surface. Covers:
//   - gate enforcement: with the gate CLOSED (the default), startLogin refuses
//     with reason 'disabled' and the credential store's write is NEVER called
//     (nothing reaches the provider flow) - the core safety property.
//   - gate open: startLogin runs the login with the OPEN gate it read.
//   - setGate: coerces non-boolean input and persists via writeGate.
//   - getStatus / disconnect: read + clear the store; unknown ids are rejected
//     without touching it.
//   - unknown provider: startLogin refuses without running a login.
//   - prompt roundtrip: an onPrompt request is emitted and resolved by submitPrompt.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

vi.mock('@/common', () => {
  const g = globalThis as Record<string, unknown>;
  const mk = (name: string): ReturnType<typeof vi.fn> => (g[name] ??= vi.fn()) as ReturnType<typeof vi.fn>;
  return {
    ipcBridge: {
      subscriptionOAuth: {
        getProviders: { provider: mk('__soGetProviders') },
        getGate: { provider: mk('__soGetGate') },
        setGate: { provider: mk('__soSetGate') },
        startLogin: { provider: mk('__soStartLogin') },
        getStatus: { provider: mk('__soGetStatus') },
        disconnect: { provider: mk('__soDisconnect') },
        submitPrompt: { provider: mk('__soSubmitPrompt') },
        onAuth: { emit: mk('__soOnAuthEmit') },
        onPrompt: { emit: mk('__soOnPromptEmit') },
        onProgress: { emit: mk('__soOnProgressEmit') },
      },
    },
  };
});

const g = globalThis as Record<string, unknown>;
const getProvidersMock = g.__soGetProviders as ReturnType<typeof vi.fn>;
const getGateMock = g.__soGetGate as ReturnType<typeof vi.fn>;
const setGateMock = g.__soSetGate as ReturnType<typeof vi.fn>;
const startLoginMock = g.__soStartLogin as ReturnType<typeof vi.fn>;
const getStatusMock = g.__soGetStatus as ReturnType<typeof vi.fn>;
const disconnectMock = g.__soDisconnect as ReturnType<typeof vi.fn>;
const submitPromptMock = g.__soSubmitPrompt as ReturnType<typeof vi.fn>;
const onPromptEmitMock = g.__soOnPromptEmit as ReturnType<typeof vi.fn>;

import {
  initSubscriptionOAuthBridge,
  type SubscriptionOAuthBridgeDeps,
} from '@process/bridge/model/providers/subscriptionOAuthBridge';
import type { OAuthCredentials, SubscriptionCredStore } from '@process/services/completion/subscriptionOAuth';

/** A vi.fn-backed cred store the tests can assert on. */
function fakeStore(): SubscriptionCredStore & {
  readMock: ReturnType<typeof vi.fn>;
  writeMock: ReturnType<typeof vi.fn>;
  clearMock: ReturnType<typeof vi.fn>;
} {
  const readMock = vi.fn().mockReturnValue(undefined);
  const writeMock = vi.fn();
  const clearMock = vi.fn();
  return { read: readMock, write: writeMock, clear: clearMock, readMock, writeMock, clearMock };
}

const CREDS: OAuthCredentials = { access: 'a', refresh: 'r', expires: 0 };

/** Grab the handler last registered on a provider mock. */
function lastHandler<T>(mock: ReturnType<typeof vi.fn>, name: string): T {
  const last = mock.mock.calls.at(-1);
  if (!last) throw new Error(`${name} provider was never registered`);
  return last[0] as T;
}

beforeEach(() => {
  for (const m of [
    getProvidersMock,
    getGateMock,
    setGateMock,
    startLoginMock,
    getStatusMock,
    disconnectMock,
    submitPromptMock,
    onPromptEmitMock,
  ]) {
    m.mockReset();
  }
});

afterEach(() => vi.clearAllMocks());

/** Init with production defaults for gate/login overridden per-test. */
function init(over: Partial<SubscriptionOAuthBridgeDeps>): void {
  const store = over.getStore ? undefined : fakeStore();
  initSubscriptionOAuthBridge({
    getStore: store ? () => Promise.resolve(store) : over.getStore,
    openExternal: vi.fn(),
    ...over,
  });
}

describe('subscriptionOAuthBridge.startLogin gate enforcement', () => {
  it('refuses with reason "disabled" and NEVER writes the store when the gate is closed', async () => {
    const store = fakeStore();
    // runLogin defaults to the REAL startSubscriptionLogin, so the closed gate is
    // enforced by the production code path, not by a stub.
    initSubscriptionOAuthBridge({
      getStore: () => Promise.resolve(store),
      readGate: () => Promise.resolve({ enabled: false, disclosureAcknowledged: false }),
      writeGate: vi.fn(),
      openExternal: vi.fn(),
    });
    const handler = lastHandler<(a: { providerId: string }) => Promise<{ ok: boolean; reason?: string }>>(
      startLoginMock,
      'startLogin'
    );
    const result = await handler({ providerId: 'anthropic-max' });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
    // The safety property: a closed gate stops the flow before any credential write.
    expect(store.writeMock).not.toHaveBeenCalled();
  });

  it('runs the login with the OPEN gate it read', async () => {
    const store = fakeStore();
    const runLogin = vi.fn().mockResolvedValue(CREDS);
    initSubscriptionOAuthBridge({
      getStore: () => Promise.resolve(store),
      readGate: () => Promise.resolve({ enabled: true, disclosureAcknowledged: true }),
      writeGate: vi.fn(),
      runLogin,
      openExternal: vi.fn(),
    });
    const handler = lastHandler<(a: { providerId: string }) => Promise<{ ok: boolean }>>(startLoginMock, 'startLogin');
    const result = await handler({ providerId: 'anthropic-max' });
    expect(result).toEqual({ ok: true });
    expect(runLogin).toHaveBeenCalledTimes(1);
    expect(runLogin.mock.calls[0][0]).toMatchObject({
      providerId: 'anthropic-max',
      gate: { enabled: true, disclosureAcknowledged: true },
      store,
    });
  });

  it('refuses an unknown provider id without running a login', async () => {
    const runLogin = vi.fn();
    init({ readGate: () => Promise.resolve({ enabled: true, disclosureAcknowledged: true }), runLogin });
    const handler = lastHandler<(a: { providerId: string }) => Promise<{ ok: boolean; reason?: string }>>(
      startLoginMock,
      'startLogin'
    );
    const result = await handler({ providerId: '../../etc/passwd' });
    expect(result).toEqual({ ok: false, reason: 'unknown-provider' });
    expect(runLogin).not.toHaveBeenCalled();
  });
});

describe('subscriptionOAuthBridge.setGate', () => {
  it('coerces non-boolean input and persists via writeGate', async () => {
    const writeGate = vi.fn();
    init({ readGate: () => Promise.resolve({ enabled: false, disclosureAcknowledged: false }), writeGate });
    const handler = lastHandler<
      (a: { enabled: unknown; disclosureAcknowledged: unknown }) => Promise<{
        enabled: boolean;
        disclosureAcknowledged: boolean;
      }>
    >(setGateMock, 'setGate');

    await expect(handler({ enabled: true, disclosureAcknowledged: true })).resolves.toEqual({
      enabled: true,
      disclosureAcknowledged: true,
    });
    expect(writeGate).toHaveBeenLastCalledWith({ enabled: true, disclosureAcknowledged: true });

    // Non-boolean 'yes' must not be treated as true.
    await expect(handler({ enabled: 'yes', disclosureAcknowledged: 0 })).resolves.toEqual({
      enabled: false,
      disclosureAcknowledged: false,
    });
  });
});

describe('subscriptionOAuthBridge.getStatus / disconnect', () => {
  it('reports connected only when the store has credentials', async () => {
    const store = fakeStore();
    init({ getStore: () => Promise.resolve(store) });
    const handler = lastHandler<(a: { providerId: string }) => Promise<{ connected: boolean }>>(
      getStatusMock,
      'getStatus'
    );

    store.readMock.mockReturnValueOnce(CREDS);
    await expect(handler({ providerId: 'anthropic-max' })).resolves.toEqual({ connected: true });

    store.readMock.mockReturnValueOnce(undefined);
    await expect(handler({ providerId: 'anthropic-max' })).resolves.toEqual({ connected: false });
  });

  it('rejects an unknown provider id without reading the store', async () => {
    const store = fakeStore();
    init({ getStore: () => Promise.resolve(store) });
    const handler = lastHandler<(a: { providerId: string }) => Promise<{ connected: boolean }>>(
      getStatusMock,
      'getStatus'
    );
    await expect(handler({ providerId: 'nope' })).resolves.toEqual({ connected: false });
    expect(store.readMock).not.toHaveBeenCalled();
  });

  it('disconnect clears the store for a valid id and no-ops an unknown one', async () => {
    const store = fakeStore();
    init({ getStore: () => Promise.resolve(store) });
    const handler = lastHandler<(a: { providerId: string }) => Promise<{ disconnected: boolean }>>(
      disconnectMock,
      'disconnect'
    );

    await expect(handler({ providerId: 'chatgpt' })).resolves.toEqual({ disconnected: true });
    expect(store.clearMock).toHaveBeenCalledWith('chatgpt');

    store.clearMock.mockClear();
    await expect(handler({ providerId: 'bogus' })).resolves.toEqual({ disconnected: false });
    expect(store.clearMock).not.toHaveBeenCalled();
  });
});

describe('subscriptionOAuthBridge prompt roundtrip', () => {
  it('emits an onPrompt request and resolves it via submitPrompt', async () => {
    const store = fakeStore();
    // A login that asks for one free-text answer, then succeeds with it.
    const runLogin = vi.fn(
      async ({ callbacks }: { callbacks: { onPrompt: (p: { message: string }) => Promise<string> } }) => {
        const answer = await callbacks.onPrompt({ message: 'paste code' });
        return { ...CREDS, access: answer };
      }
    );
    initSubscriptionOAuthBridge({
      getStore: () => Promise.resolve(store),
      readGate: () => Promise.resolve({ enabled: true, disclosureAcknowledged: true }),
      writeGate: vi.fn(),
      runLogin: runLogin as unknown as SubscriptionOAuthBridgeDeps['runLogin'],
      openExternal: vi.fn(),
    });

    const startHandler = lastHandler<(a: { providerId: string }) => Promise<{ ok: boolean }>>(
      startLoginMock,
      'startLogin'
    );
    const submitHandler = lastHandler<(a: { promptId: string; value: string }) => Promise<void>>(
      submitPromptMock,
      'submitPrompt'
    );

    const loginPromise = startHandler({ providerId: 'anthropic-max' });
    // The prompt request must have been emitted with a promptId.
    await vi.waitFor(() => expect(onPromptEmitMock).toHaveBeenCalledTimes(1));
    const promptId = (onPromptEmitMock.mock.calls[0][0] as { promptId: string }).promptId;
    expect(promptId).toBeTruthy();

    await submitHandler({ promptId, value: 'THE-CODE' });
    await expect(loginPromise).resolves.toEqual({ ok: true });
  });
});
