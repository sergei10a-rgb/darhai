/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression guard for the storage half of the IPC bridge's error path.
 *
 * `withBridgeErrorPropagation` repairs the vendored platform's missing provider
 * error path, and `bridgeAllowlist.buildProvider` applies it to every provider
 * we declare. Storage bypassed all of it: `storage.buildStorage` from
 * @office-ai/platform calls `bridge.buildProvider` INTERNALLY, so the four wire
 * keys it registers per namespace (`get` / `set` / `clear` / `remove`) went to
 * the renderer through the unrepaired protocol. A storage interceptor that
 * threw - a corrupt profile, an EPERM on the config file, a full disk - emitted
 * NOTHING back, and the renderer's promise stayed pending forever.
 * `ConfigStorage.get` is on the boot path of most screens, so that is an app
 * that never finishes loading with no error anywhere.
 *
 * These tests run against the REAL @office-ai/platform emitter, wired into an
 * in-process loopback via `bridge.adapter`, because the defect lives in that
 * package's exact wire behaviour. The last test pins the platform's own
 * `buildStorage` still hanging, so the ones above cannot quietly become
 * tautologies if the vendored package is ever updated.
 */
import { describe, test, expect, vi, beforeAll, afterEach } from 'vitest';
import type EventEmitter from 'eventemitter3';
import { bridge, storage as platformStorage } from '@office-ai/platform';
import { buildStorage, isAllowedInboundName } from '../../src/common/adapter/bridgeAllowlist';

/** Anything slower than this counts as "hung" for these tests. */
const SETTLE_BUDGET_MS = 500;

type ProbeRefer = { 'probe.key': string };

/**
 * Wire the platform's emitter to itself.
 *
 * `bridge.adapter({ on, emit })` hands us the package's internal EventEmitter
 * and takes over its outbound `emit`. Feeding one straight back into the other
 * gives a faithful single-process loopback: `invoke` really does travel the
 * `subscribe-<key>` / `subscribe.callback-<key><id>` protocol, including the
 * part with no reject path.
 */
beforeAll(() => {
  let internal: EventEmitter | undefined;
  bridge.adapter({
    on: (emitter: EventEmitter) => {
      internal = emitter;
    },
    emit: (name: string, data: unknown, ...args: unknown[]) => {
      internal?.emit(name, data, ...args);
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Resolve to `'pending'` when `promise` has not settled within the budget. */
async function settleWithin<T>(promise: Promise<T>): Promise<'pending' | { ok: T } | { err: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), SETTLE_BUDGET_MS);
  });
  const outcome = await Promise.race([
    promise.then((value) => ({ ok: value }) as const).catch((error: unknown) => ({ err: error }) as const),
    deadline,
  ]);
  if (timer) clearTimeout(timer);
  return outcome;
}

function silenceProviderLogs(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

let namespaceCounter = 0;
/** A fresh namespace per test - provider registration is global to the emitter. */
function freshNamespace(): string {
  namespaceCounter += 1;
  return `darhai.test.storage.${namespaceCounter}`;
}

describe('buildStorage error propagation', () => {
  test('records all four wire keys in the C1 inbound allowlist', () => {
    const ns = freshNamespace();
    buildStorage<ProbeRefer>(ns);

    for (const verb of ['get', 'set', 'clear', 'remove']) {
      expect(isAllowedInboundName(`subscribe-${ns}.storage.${verb}`), `${verb} is not allowlisted`).toBe(true);
    }
    expect(isAllowedInboundName(`subscribe-${ns}.storage.nonsense`)).toBe(false);
  });

  test('get rejects the caller when the interceptor throws, instead of hanging forever', async () => {
    silenceProviderLogs();
    const ns = freshNamespace();
    const store = buildStorage<ProbeRefer>(ns);
    store.interceptor({
      get: () => Promise.reject(new Error('EPERM: operation not permitted, open wayland-config.txt')),
    });

    const outcome = await settleWithin(store.get('probe.key'));

    expect(outcome, 'storage.get never settled - the renderer would spin forever').not.toBe('pending');
    const error = (outcome as { err: unknown }).err;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('EPERM: operation not permitted, open wayland-config.txt');
    expect((error as Error & { bridgeKey?: string }).bridgeKey).toBe(`${ns}.storage.get`);
  });

  test('set, remove and clear reject too - every mutating verb, not just the read', async () => {
    silenceProviderLogs();
    const ns = freshNamespace();
    const store = buildStorage<ProbeRefer>(ns);
    store.interceptor({
      set: () => Promise.reject(new Error('ENOSPC: no space left on device')),
      remove: () => Promise.reject(new Error('remove failed')),
      clear: () => Promise.reject(new Error('clear failed')),
    });

    const setOutcome = await settleWithin(store.set('probe.key', 'value'));
    const removeOutcome = await settleWithin(store.remove('probe.key'));
    const clearOutcome = await settleWithin(store.clear());

    expect(setOutcome).not.toBe('pending');
    expect(((setOutcome as { err: Error }).err as Error).message).toBe('ENOSPC: no space left on device');
    expect(removeOutcome).not.toBe('pending');
    expect(((removeOutcome as { err: Error }).err as Error).message).toBe('remove failed');
    expect(clearOutcome).not.toBe('pending');
    expect(((clearOutcome as { err: Error }).err as Error).message).toBe('clear failed');
  });

  test('a handler that throws SYNCHRONOUSLY is answered too', async () => {
    silenceProviderLogs();
    const ns = freshNamespace();
    const store = buildStorage<ProbeRefer>(ns);
    store.interceptor({
      get: (() => {
        // The platform calls `handler(data).then(...)` unconditionally, so a
        // synchronous throw used to blow up inside the emitter itself.
        throw new Error('The "path" argument must be of type string without null bytes');
      }) as () => Promise<string>,
    });

    const outcome = await settleWithin(store.get('probe.key'));

    expect(outcome).not.toBe('pending');
    expect(((outcome as { err: Error }).err as Error).message).toContain('without null bytes');
  });
});

describe('buildStorage wire compatibility', () => {
  test('round-trips values through the platform protocol unchanged', async () => {
    const ns = freshNamespace();
    const store = buildStorage<ProbeRefer>(ns);
    const backing = new Map<string, string>();
    const seenSets: Array<[string, string]> = [];

    store.interceptor({
      get: async (key) => backing.get(String(key)) as string,
      set: async (key, data) => {
        seenSets.push([String(key), data]);
        backing.set(String(key), data);
        return data;
      },
      remove: async (key) => backing.delete(String(key)),
      clear: async () => backing.clear(),
    });

    await store.set('probe.key', 'hello');
    // The platform's `set` travels as `{ key, data }` and the interceptor is
    // called with the pair split back out - a shape mismatch here would break
    // every persisted setting in the app.
    expect(seenSets).toEqual([['probe.key', 'hello']]);
    await expect(store.get('probe.key')).resolves.toBe('hello');

    await store.remove('probe.key');
    await expect(store.get('probe.key')).resolves.toBeUndefined();

    await store.set('probe.key', 'again');
    await store.clear();
    await expect(store.get('probe.key')).resolves.toBeUndefined();
  });

  test('a namespace with no interceptor registered does not answer - unchanged platform behaviour', async () => {
    const store = buildStorage<ProbeRefer>(freshNamespace());
    // Nothing is listening on the wire key, so nothing replies. Documented
    // rather than "fixed": inventing a reply here would hide a missing
    // `interceptor()` call at boot instead of surfacing it.
    expect(await settleWithin(store.get('probe.key'))).toBe('pending');
  });
});

describe('the defect this replaces', () => {
  test("the platform's own buildStorage still hangs on a throwing handler", async () => {
    // The anchor for everything above: if this ever starts settling, the
    // vendored package grew its own error path and the tests above stopped
    // proving anything.
    const store = platformStorage.buildStorage<ProbeRefer>(freshNamespace());
    store.interceptor({ get: () => Promise.reject(new Error('boom')) });

    // The rejection is unobservable by design - it becomes an
    // `[unhandledRejection]` in main and nothing on the wire. Swallow it here
    // so it does not fail the run it is documenting.
    const pendingRejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      pendingRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(await settleWithin(store.get('probe.key'))).toBe('pending');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
