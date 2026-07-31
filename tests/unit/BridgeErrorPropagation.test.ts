/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression guard for the IPC bridge's missing error path.
 *
 * The vendored @office-ai/platform provider protocol emits the reply callback
 * ONLY from the handler's `.then` and has no reject path on the caller side, so
 * a handler that throws used to leave the renderer's promise pending forever -
 * every failure in the app became an infinite spinner with no message.
 *
 * `withBridgeErrorPropagation` repairs the contract on our side of the vendored
 * package. These tests run against a faithful reproduction of the platform's
 * behaviour (see `createPlatformLikeProvider`) rather than a convenient mock,
 * because the whole defect lives in that exact "no `.catch`, no reject" shape.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BRIDGE_ERROR_MARKER,
  isBridgeErrorEnvelope,
  toBridgeErrorEnvelope,
  fromBridgeErrorEnvelope,
  withBridgeErrorPropagation,
  type BridgeProviderApi,
} from '../../src/common/adapter/bridgeError';

/** Anything longer than this counts as "hung" for the purposes of these tests. */
const SETTLE_BUDGET_MS = 500;

type Handler = (params: unknown) => Promise<unknown>;

/**
 * A reproduction of `bridge.buildProvider(key)` from @office-ai/platform.
 *
 * Faithful to the two properties that matter, both verified against
 * `node_modules/@office-ai/platform/dist/index.js`:
 *   - the provider side is `handler(data).then(res => emitCallback(res))` with
 *     NO `.catch`, so a rejection emits nothing, and
 *   - the caller side is `new Promise(resolve => onCallback(resolve))` with no
 *     reject path and no timeout, so it waits forever.
 */
function createPlatformLikeProvider(): {
  api: BridgeProviderApi<unknown, unknown>;
  /** The handler the platform actually registered (i.e. our wrapper's). */
  registered: () => Handler;
} {
  let handler: Handler | undefined;

  const api = {
    provider: (next: Handler) => {
      handler = next;
    },
    invoke: (params: unknown) =>
      new Promise((resolve) => {
        // Exactly the upstream shape: no `.catch`, so a rejected handler
        // resolves nothing and the returned promise stays pending.
        void handler?.(params).then((result) => resolve(result));
      }),
  };

  return {
    api: api as unknown as BridgeProviderApi<unknown, unknown>,
    registered: () => {
      if (!handler) throw new Error('no handler registered');
      return handler;
    },
  };
}

/** Resolve to `'pending'` if `promise` has not settled within the budget. */
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

describe('withBridgeErrorPropagation', () => {
  beforeEach(() => {
    // The wrapper logs every provider failure; keep the suite output readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('rejects the caller when the provider handler throws, instead of hanging forever', async () => {
    const base = createPlatformLikeProvider();
    const wrapped = withBridgeErrorPropagation('calendar.create', base.api);
    wrapped.provider(() => Promise.reject(new Error('calendar.create: userId, startMs and endMs are required')));

    const outcome = await settleWithin((wrapped.invoke as (p: unknown) => Promise<unknown>)({}));

    expect(outcome, 'invoke never settled - the renderer would spin forever').not.toBe('pending');
    const error = (outcome as { err: unknown }).err;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('calendar.create: userId, startMs and endMs are required');
    expect((error as Error & { bridgeKey: string }).bridgeKey).toBe('calendar.create');
  });

  test('rejects when the handler throws synchronously', async () => {
    // The platform calls `handler(data).then(...)` unconditionally, so a
    // synchronous throw used to blow up inside the emitter itself.
    const base = createPlatformLikeProvider();
    const wrapped = withBridgeErrorPropagation('note.update', base.api);
    wrapped.provider((() => {
      throw new Error('Note not found: definitely-not-a-note');
    }) as () => Promise<unknown>);

    const outcome = await settleWithin((wrapped.invoke as (p: unknown) => Promise<unknown>)({}));

    expect(outcome).not.toBe('pending');
    expect((outcome as { err: unknown }).err).toBeInstanceOf(Error);
    expect(((outcome as { err: Error }).err as Error).message).toBe('Note not found: definitely-not-a-note');
  });

  test('leaves the registered handler resolving, so main never sees an unhandled rejection', async () => {
    const base = createPlatformLikeProvider();
    const wrapped = withBridgeErrorPropagation('documents.create', base.api);
    wrapped.provider(() => Promise.reject(new Error('documents.create: userId is required')));

    // This is the promise the platform attaches `.then` to. If it REJECTS, the
    // main process logs `[unhandledRejection]`; it must resolve instead.
    await expect(base.registered()({})).resolves.toMatchObject({
      [BRIDGE_ERROR_MARKER]: { key: 'documents.create', message: 'documents.create: userId is required' },
    });
  });

  test('carries the error code when the original failure had one', async () => {
    const base = createPlatformLikeProvider();
    const wrapped = withBridgeErrorPropagation('calendar.create', base.api);
    const sqliteLike = Object.assign(new Error('FOREIGN KEY constraint failed'), {
      name: 'SqliteError',
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
    wrapped.provider(() => Promise.reject(sqliteLike));

    const outcome = await settleWithin((wrapped.invoke as (p: unknown) => Promise<unknown>)({}));

    const error = (outcome as { err: Error & { code?: string } }).err;
    expect(error.name).toBe('SqliteError');
    expect(error.code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });

  test('passes a successful result through untouched', async () => {
    const base = createPlatformLikeProvider();
    const wrapped = withBridgeErrorPropagation('cron.list-jobs', base.api);
    const jobs = [{ id: 'job-1' }];
    wrapped.provider(() => Promise.resolve(jobs));

    const outcome = await settleWithin((wrapped.invoke as (p: unknown) => Promise<unknown>)(undefined));

    expect(outcome).toEqual({ ok: jobs });
  });

  test('forwards the invoke params to the handler unchanged', async () => {
    const base = createPlatformLikeProvider();
    const wrapped = withBridgeErrorPropagation('note.get', base.api);
    const seen: unknown[] = [];
    wrapped.provider(((params: unknown) => {
      seen.push(params);
      return Promise.resolve(null);
    }) as (params: unknown) => Promise<unknown>);

    await (wrapped.invoke as (p: unknown) => Promise<unknown>)({ noteId: 'n-1' });

    expect(seen).toEqual([{ noteId: 'n-1' }]);
  });

  test('re-registering a provider replaces the previous handler', async () => {
    const base = createPlatformLikeProvider();
    const wrapped = withBridgeErrorPropagation('note.list', base.api);
    wrapped.provider(() => Promise.resolve('first'));
    wrapped.provider(() => Promise.resolve('second'));

    await expect((wrapped.invoke as (p: unknown) => Promise<unknown>)(undefined)).resolves.toBe('second');
  });
});

describe('bridge error envelope', () => {
  test('recognises its own envelope and nothing else', () => {
    expect(isBridgeErrorEnvelope(toBridgeErrorEnvelope('note.create', new Error('boom')))).toBe(true);
    // Ordinary provider payloads must never be mistaken for a failure.
    expect(isBridgeErrorEnvelope({ success: false, msg: 'boom' })).toBe(false);
    expect(isBridgeErrorEnvelope([{ id: 'a' }])).toBe(false);
    expect(isBridgeErrorEnvelope(null)).toBe(false);
    expect(isBridgeErrorEnvelope(undefined)).toBe(false);
    expect(isBridgeErrorEnvelope('note.create')).toBe(false);
    expect(isBridgeErrorEnvelope({ [BRIDGE_ERROR_MARKER]: 'not-a-payload' })).toBe(false);
  });

  test('survives JSON serialization, which is how it crosses the wire', () => {
    const envelope = toBridgeErrorEnvelope('project.write-knowledge', new Error('Project has no workspace folder'));
    const onWire: unknown = JSON.parse(JSON.stringify(envelope));

    expect(isBridgeErrorEnvelope(onWire)).toBe(true);
    const error = fromBridgeErrorEnvelope(onWire as ReturnType<typeof toBridgeErrorEnvelope>);
    expect(error.message).toBe('Project has no workspace folder');
    expect(error.bridgeKey).toBe('project.write-knowledge');
  });

  test('omits the stack, which would leak host paths to paired WebUI clients', () => {
    const envelope = toBridgeErrorEnvelope('note.create', new Error('boom'));
    expect(JSON.stringify(envelope)).not.toContain('stack');
    expect(Object.keys(envelope[BRIDGE_ERROR_MARKER])).toEqual(['key', 'name', 'message']);
  });

  test('describes non-Error throws without losing them', () => {
    const fromString = toBridgeErrorEnvelope('note.create', 'plain string failure');
    expect(fromString[BRIDGE_ERROR_MARKER].message).toBe('plain string failure');

    const fromObject = toBridgeErrorEnvelope('note.create', { name: 'HttpError', message: 'gateway timeout' });
    expect(fromObject[BRIDGE_ERROR_MARKER].name).toBe('HttpError');
    expect(fromObject[BRIDGE_ERROR_MARKER].message).toBe('gateway timeout');
  });
});
