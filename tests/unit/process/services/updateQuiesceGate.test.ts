/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The update that restarted the app mid-task.
 *
 * Clicking Install (or the staged auto-update applying) restarted Darhai no
 * matter what it was doing: an agent mid-answer, a cron job mid-run, a team
 * mid-wake. The work was simply gone. Darhai is server-like - it should apply
 * updates on idle or on quit, the way VS Code and Slack do.
 *
 * The gate's contract, each line of which is tested here:
 *  - busy + defer enabled  -> install deferred until the app goes idle;
 *  - idle                  -> install immediately;
 *  - defer disabled        -> install immediately even while busy;
 *  - repeated requests while deferred -> exactly ONE install at idle;
 *  - a config read failure -> the SAFE default (defer), never the rug-pull.
 *
 * And the guard side: the app-idle callback must not fire while anything is
 * still processing, must fire once the last conversation clears, and must
 * re-arm if work resumes in the same breath.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CronBusyGuard, cronBusyGuard } from '@process/services/cron/CronBusyGuard';

const configGet = vi.fn();

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: {
    get: (...args: unknown[]) => configGet(...(args as [])),
  },
}));

import { __resetForTest, installOrDefer, isAppBusy } from '@process/services/updateQuiesceGate';

/** Let the guard's setImmediate-deferred idle callbacks run. */
const flushImmediates = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

beforeEach(() => {
  cronBusyGuard.clear();
  __resetForTest();
  configGet.mockReset();
  configGet.mockResolvedValue(undefined); // default: defer enabled
});

afterEach(() => {
  cronBusyGuard.clear();
});

describe('CronBusyGuard app-wide idle', () => {
  it('is idle with no conversations, busy with one processing', () => {
    const guard = new CronBusyGuard();
    expect(guard.isAppBusy()).toBe(false);
    guard.setProcessing('c1', true);
    expect(guard.isAppBusy()).toBe(true);
    guard.setProcessing('c1', false);
    expect(guard.isAppBusy()).toBe(false);
  });

  it('stays busy until the LAST conversation clears', () => {
    const guard = new CronBusyGuard();
    guard.setProcessing('c1', true);
    guard.setProcessing('c2', true);
    guard.setProcessing('c1', false);
    expect(guard.isAppBusy()).toBe(true);
    guard.setProcessing('c2', false);
    expect(guard.isAppBusy()).toBe(false);
  });

  it('fires onceAllIdle immediately when already idle', () => {
    const guard = new CronBusyGuard();
    const cb = vi.fn();
    guard.onceAllIdle(cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires onceAllIdle once the last conversation clears - and only then', async () => {
    const guard = new CronBusyGuard();
    guard.setProcessing('c1', true);
    guard.setProcessing('c2', true);
    const cb = vi.fn();
    guard.onceAllIdle(cb);

    guard.setProcessing('c1', false);
    await flushImmediates();
    expect(cb).not.toHaveBeenCalled(); // c2 still working

    guard.setProcessing('c2', false);
    await flushImmediates();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not fire synchronously - turn teardown clears busy FIRST and keeps working', async () => {
    // WCore marks the conversation idle at the start of teardown, then flushes
    // buffered text and can start a follow-up turn. A synchronous fire would
    // restart the app inside that finalization.
    const guard = new CronBusyGuard();
    guard.setProcessing('c1', true);
    const cb = vi.fn();
    guard.onceAllIdle(cb);

    guard.setProcessing('c1', false);
    expect(cb).not.toHaveBeenCalled(); // not yet - only after the macrotask

    await flushImmediates();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('re-arms when work resumes before the deferred callback runs', async () => {
    const guard = new CronBusyGuard();
    guard.setProcessing('c1', true);
    const cb = vi.fn();
    guard.onceAllIdle(cb);

    guard.setProcessing('c1', false);
    // A follow-up turn re-asserts busy in the same tick, before setImmediate.
    guard.setProcessing('c1', true);
    await flushImmediates();
    expect(cb).not.toHaveBeenCalled(); // must NOT have fired mid-work

    guard.setProcessing('c1', false);
    await flushImmediates();
    expect(cb).toHaveBeenCalledTimes(1); // fires on the real idle
  });

  it('fires when removing the last busy conversation flips the app idle', async () => {
    const guard = new CronBusyGuard();
    guard.setProcessing('c1', true);
    const cb = vi.fn();
    guard.onceAllIdle(cb);

    guard.remove('c1'); // conversation deleted mid-run
    await flushImmediates();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('installOrDefer', () => {
  it('installs immediately when the app is idle', async () => {
    const install = vi.fn();
    const result = await installOrDefer(install);
    expect(result).toBe('installing');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('defers while busy, then installs exactly once on idle', async () => {
    cronBusyGuard.setProcessing('c1', true);
    const install = vi.fn();
    const onDeferred = vi.fn();

    const result = await installOrDefer(install, onDeferred);

    expect(result).toBe('deferred');
    expect(onDeferred).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled(); // the whole point: no mid-task restart

    cronBusyGuard.setProcessing('c1', false);
    await flushImmediates();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('installs even while busy when the user turned defer OFF', async () => {
    configGet.mockResolvedValue(false);
    cronBusyGuard.setProcessing('c1', true);
    const install = vi.fn();

    const result = await installOrDefer(install);

    expect(result).toBe('installing');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('clicking Install repeatedly while busy still installs exactly once', async () => {
    cronBusyGuard.setProcessing('c1', true);
    const install = vi.fn();
    const onDeferred = vi.fn();

    await installOrDefer(install, onDeferred);
    await installOrDefer(install, onDeferred);
    await installOrDefer(install, onDeferred);

    // Every click re-surfaces the deferred UX...
    expect(onDeferred).toHaveBeenCalledTimes(3);

    cronBusyGuard.setProcessing('c1', false);
    await flushImmediates();
    // ...but the idle moment fires ONE install, not three restarts.
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('falls back to deferring when the setting cannot be read', async () => {
    // The failure mode must be "wait", never "yank the rug".
    configGet.mockRejectedValue(new Error('config store unavailable'));
    cronBusyGuard.setProcessing('c1', true);
    const install = vi.fn();

    const result = await installOrDefer(install);

    expect(result).toBe('deferred');
    expect(install).not.toHaveBeenCalled();
  });

  it('exposes the busy signal the bridge and tests key on', () => {
    expect(isAppBusy()).toBe(false);
    cronBusyGuard.setProcessing('c1', true);
    expect(isAppBusy()).toBe(true);
  });
});
