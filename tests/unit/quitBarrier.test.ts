/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression guard for the bounded quit barrier.
 *
 * Electron does not await async `before-quit` handlers - measured on this
 * build, `before-quit` and `will-quit` are ~23ms apart with the process already
 * going away - so the app's cleanup bundle (SQLite close, cron shutdown,
 * cookbook llama-server teardown, fork workers) was cut off mid-flight. The
 * barrier cancels the cancellable event, waits, and exits.
 *
 * The dangerous failure mode of that fix is the opposite one: a quit that never
 * completes. Every test below is about the guarantee that cannot regress -
 * `exit()` is called EXACTLY ONCE, on every path, including the ones where the
 * cleanup rejects or never settles at all.
 */
import { describe, test, expect, vi } from 'vitest';
import { createQuitBarrier, type QuitBarrierDeps } from '../../src/process/utils/quitBarrier';

const CEILING_MS = 12_000;

type Harness = {
  barrier: ReturnType<typeof createQuitBarrier>;
  exits: number;
  /** Fire the pending ceiling timer, if one was scheduled. */
  fireCeiling: () => void;
  /** Timers still scheduled (i.e. not cleared). */
  pendingTimers: () => number;
  logs: string[];
};

/**
 * A barrier with the clock and the timer under the test's control, so nothing
 * here sleeps and "the ceiling fired" is an assertion rather than a race.
 */
function harness(overrides: Partial<QuitBarrierDeps> = {}): Harness {
  const logs: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  let exits = 0;

  const barrier = createQuitBarrier({
    ceilingMs: CEILING_MS,
    exit: () => {
      exits += 1;
    },
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    now: () => 0,
    setTimer: (fn) => {
      const id = nextTimerId++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    ...overrides,
  });

  return {
    barrier,
    get exits() {
      return exits;
    },
    fireCeiling: () => {
      const entries = Array.from(timers.entries());
      for (const [id, fn] of entries) {
        timers.delete(id);
        fn();
      }
    },
    pendingTimers: () => timers.size,
    logs,
  } as Harness;
}

/** Let every already-resolved promise callback run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createQuitBarrier', () => {
  test('does not hold the quit when no cleanup was ever started', () => {
    const h = harness();
    expect(h.barrier.hold()).toBe(false);
    expect(h.exits).toBe(0);
  });

  test('does not hold the quit when the cleanup has already finished', async () => {
    const h = harness();
    h.barrier.begin(() => Promise.resolve());
    await flush();

    expect(h.barrier.isSettled()).toBe(true);
    expect(h.barrier.hold(), 'nothing left to wait for - Electron should just quit').toBe(false);
    expect(h.exits).toBe(0);
  });

  test('holds an in-flight cleanup and exits once it resolves', async () => {
    const h = harness();
    let release!: () => void;
    h.barrier.begin(() => new Promise<void>((resolve) => (release = resolve)));

    expect(h.barrier.hold(), 'caller must preventDefault while cleanup is in flight').toBe(true);
    expect(h.exits, 'must not exit before the cleanup finishes').toBe(0);

    release();
    await flush();

    expect(h.exits).toBe(1);
    expect(h.pendingTimers(), 'the ceiling timer must be cleared once cleanup wins').toBe(0);
  });

  test('exits even when the cleanup REJECTS', async () => {
    const h = harness();
    let fail!: (err: Error) => void;
    h.barrier.begin(() => new Promise<void>((_resolve, reject) => (fail = reject)));

    expect(h.barrier.hold()).toBe(true);
    fail(new Error('closeDatabase threw'));
    await flush();

    expect(h.exits, 'a failing cleanup must still let the app quit').toBe(1);
  });

  test('exits at the ceiling when the cleanup never settles', async () => {
    const h = harness();
    // A cleanup that wedges forever is exactly the scenario in which a naive
    // preventDefault turns "quit" into "hang".
    h.barrier.begin(() => new Promise<void>(() => {}));

    expect(h.barrier.hold()).toBe(true);
    expect(h.exits).toBe(0);

    h.fireCeiling();
    await flush();

    expect(h.exits).toBe(1);
    expect(h.logs.some((l) => l.includes(`ceiling (${CEILING_MS}ms) reached`))).toBe(true);
  });

  test('exits exactly once when the ceiling and the cleanup both fire', async () => {
    const h = harness();
    let release!: () => void;
    h.barrier.begin(() => new Promise<void>((resolve) => (release = resolve)));
    h.barrier.hold();

    h.fireCeiling();
    release();
    await flush();

    expect(h.exits, 'a double exit would race the OS teardown').toBe(1);
  });

  test('a repeated will-quit re-cancels without scheduling a second exit', async () => {
    const h = harness();
    let release!: () => void;
    h.barrier.begin(() => new Promise<void>((resolve) => (release = resolve)));

    expect(h.barrier.hold()).toBe(true);
    expect(h.barrier.hold()).toBe(true);
    expect(h.barrier.hold()).toBe(true);
    expect(h.pendingTimers(), 'only one ceiling timer may exist').toBe(1);

    release();
    await flush();
    expect(h.exits).toBe(1);
  });

  test('a re-entrant quit does not run the cleanup twice', async () => {
    const h = harness();
    const run = vi.fn(() => Promise.resolve());

    h.barrier.begin(run);
    h.barrier.begin(run);
    h.barrier.begin(() => Promise.reject(new Error('a different run')));
    await flush();

    expect(run, 'tearing the same subsystems down twice is its own bug').toHaveBeenCalledTimes(1);
  });

  test('reports how long the cleanup took, so a truncated quit is visible in the log', async () => {
    let clock = 1_000;
    const h = harness({ now: () => clock });
    let release!: () => void;
    h.barrier.begin(() => new Promise<void>((resolve) => (release = resolve)));

    clock = 1_450;
    release();
    await flush();

    expect(h.logs).toContain('[Wayland] quit cleanup finished in 450ms');
  });
});
