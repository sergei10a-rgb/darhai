/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The engine children that outlived the app.
 *
 * Closing Darhai could leave the wcore engine and the ACP backends running.
 * The graceful path - `WorkerTaskManager.clear()` awaiting each manager's
 * `kill()` - exists, but it runs under a 2s per-step budget while a single
 * `killChild` is allowed 3s on POSIX and 5s on Windows, so a slow or
 * SIGTERM-ignoring child was abandoned mid-kill; and a child spawned outside a
 * tracked manager was never reached at all. On Windows those survivors keep
 * handles on files in the install directory, which is what made the next update
 * or uninstall fail to replace them.
 *
 * This registry is the last-resort sweep. The properties that matter are that
 * it forgets children the moment they end (or it would grow across a session,
 * and worse, try to kill the dead), that it never kills a pid Node has already
 * reaped (that pid may belong to a stranger by now), and that one child
 * refusing to die cannot stop the others or the quit.
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const killChild = vi.fn(async (..._args: unknown[]) => {});
const isProcessAlive = vi.fn(() => true);
const execFileSync = vi.hoisted(() => vi.fn());

vi.mock('@process/agent/acp/utils', () => ({
  killChild: (...args: unknown[]) => killChild(...(args as [])),
  isProcessAlive: (...args: unknown[]) => isProcessAlive(...(args as [])),
}));

vi.mock('child_process', () => ({ execFileSync }));

/** Run `fn` as if the process were on `platform`, then put it back. */
function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

import {
  listTrackedAgentChildren,
  reapAgentChildrenSync,
  reapOrphanedAgentChildren,
  registerAgentChild,
  resetAgentChildRegistry,
  trackedAgentChildCount,
  unregisterAgentChild,
} from '@process/agent/childRegistry';

/** A child process stand-in with the two fields the pid-reuse guard reads. */
function fakeChild(pid: number | undefined, opts: { exitCode?: number | null; signalCode?: string | null } = {}) {
  const emitter = new EventEmitter() as unknown as ChildProcess & EventEmitter;
  Object.assign(emitter, {
    pid,
    exitCode: opts.exitCode ?? null,
    signalCode: opts.signalCode ?? null,
  });
  return emitter;
}

beforeEach(() => {
  resetAgentChildRegistry();
  killChild.mockClear();
  isProcessAlive.mockClear();
  isProcessAlive.mockReturnValue(true);
  execFileSync.mockClear();
  execFileSync.mockReturnValue(Buffer.from(''));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerAgentChild', () => {
  it('tracks a spawned child', () => {
    registerAgentChild(fakeChild(4321), { label: 'wcore' });
    expect(trackedAgentChildCount()).toBe(1);
    expect(listTrackedAgentChildren()[0]).toMatchObject({ pid: 4321, label: 'wcore', detached: false });
  });

  it('records the detached flag, because POSIX signals the group differently', () => {
    registerAgentChild(fakeChild(11), { label: 'acp:claude', detached: true });
    expect(listTrackedAgentChildren()[0].detached).toBe(true);
  });

  it('ignores a child that never got a pid', () => {
    // A spawn that failed before the OS assigned one. There is nothing to reap.
    registerAgentChild(fakeChild(undefined), { label: 'wcore' });
    expect(trackedAgentChildCount()).toBe(0);
  });

  it.each(['exit', 'close', 'error'])('forgets the child on %s', (event) => {
    const child = fakeChild(77);
    registerAgentChild(child, { label: 'wcore' });
    expect(trackedAgentChildCount()).toBe(1);

    child.emit(event);
    expect(trackedAgentChildCount()).toBe(0);
  });

  it('does not grow across a long session of short-lived children', () => {
    for (let i = 1; i <= 50; i++) {
      const child = fakeChild(1000 + i);
      registerAgentChild(child, { label: 'acp:gemini' });
      child.emit('exit');
    }
    expect(trackedAgentChildCount()).toBe(0);
  });
});

describe('unregisterAgentChild', () => {
  it('drops a pid a caller killed itself', () => {
    registerAgentChild(fakeChild(9), { label: 'wcore' });
    unregisterAgentChild(9);
    expect(trackedAgentChildCount()).toBe(0);
  });

  it('tolerates an undefined pid', () => {
    registerAgentChild(fakeChild(9), { label: 'wcore' });
    unregisterAgentChild(undefined);
    expect(trackedAgentChildCount()).toBe(1);
  });
});

describe('reapOrphanedAgentChildren', () => {
  it('does nothing when the graceful teardown already worked', async () => {
    // The common case: every child unregistered itself on exit.
    const result = await reapOrphanedAgentChildren();
    expect(result).toEqual({ reaped: 0, failed: 0 });
    expect(killChild).not.toHaveBeenCalled();
  });

  it('tree-kills a child that survived teardown', async () => {
    const child = fakeChild(555);
    registerAgentChild(child, { label: 'wcore' });

    const result = await reapOrphanedAgentChildren();

    expect(result).toEqual({ reaped: 1, failed: 0 });
    expect(killChild).toHaveBeenCalledWith(child, false, 'wcore');
  });

  it('passes the detached flag through to the kill', async () => {
    const child = fakeChild(556);
    registerAgentChild(child, { label: 'acp:codex', detached: true });

    await reapOrphanedAgentChildren();

    expect(killChild).toHaveBeenCalledWith(child, true, 'acp:codex');
  });

  it('does not kill a pid Node has already reaped', async () => {
    // The pid may belong to an unrelated process by now. `exitCode` is the only
    // signal that cannot be fooled by pid reuse, so it decides.
    registerAgentChild(fakeChild(600, { exitCode: 0 }), { label: 'wcore' });

    const result = await reapOrphanedAgentChildren();

    expect(result).toEqual({ reaped: 0, failed: 0 });
    expect(killChild).not.toHaveBeenCalled();
  });

  it('does not kill a child that was terminated by a signal', async () => {
    registerAgentChild(fakeChild(601, { signalCode: 'SIGTERM' }), { label: 'wcore' });

    await reapOrphanedAgentChildren();

    expect(killChild).not.toHaveBeenCalled();
  });

  it('does not kill a pid that is no longer alive', async () => {
    isProcessAlive.mockReturnValue(false);
    registerAgentChild(fakeChild(602), { label: 'wcore' });

    const result = await reapOrphanedAgentChildren();

    expect(result).toEqual({ reaped: 0, failed: 0 });
    expect(killChild).not.toHaveBeenCalled();
  });

  it('keeps going when one kill throws, and reports it', async () => {
    // One process refusing to die must not strand the others - or the quit.
    const stubborn = fakeChild(700);
    const ordinary = fakeChild(701);
    registerAgentChild(stubborn, { label: 'wcore' });
    registerAgentChild(ordinary, { label: 'acp:claude' });
    killChild.mockImplementation(async (child: unknown) => {
      if (child === stubborn) throw new Error('taskkill refused');
    });

    const result = await reapOrphanedAgentChildren();

    expect(result).toEqual({ reaped: 1, failed: 1 });
    expect(killChild).toHaveBeenCalledTimes(2);
  });

  it('never rejects, so it cannot turn a quit into a hang', async () => {
    registerAgentChild(fakeChild(800), { label: 'wcore' });
    killChild.mockRejectedValue(new Error('boom'));

    await expect(reapOrphanedAgentChildren()).resolves.toEqual({ reaped: 0, failed: 1 });
  });

  it('empties the registry so a second sweep is a no-op', async () => {
    registerAgentChild(fakeChild(900), { label: 'wcore' });

    await reapOrphanedAgentChildren();
    expect(trackedAgentChildCount()).toBe(0);

    killChild.mockClear();
    await reapOrphanedAgentChildren();
    expect(killChild).not.toHaveBeenCalled();
  });
});

/**
 * `app.exit()` emits neither `before-quit` nor `will-quit`, so the async sweep
 * never runs on the crash path, the init-failure path, or an externally driven
 * exit - the exits most likely to strand an engine. A `process.on('exit')`
 * handler is the only thing that still gets a turn there, and nothing async
 * survives inside one, so this path has to be synchronous end to end.
 */
describe('reapAgentChildrenSync', () => {
  it('hard-kills the tree with taskkill on Windows', () => {
    registerAgentChild(fakeChild(1234), { label: 'wcore' });

    const killed = onPlatform('win32', () => reapAgentChildrenSync());

    expect(killed).toBe(1);
    expect(execFileSync).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '1234', '/T', '/F'],
      expect.objectContaining({ timeout: 2000 })
    );
  });

  it('bounds the taskkill, so a wedged one cannot hold the dying process open', () => {
    registerAgentChild(fakeChild(1235), { label: 'wcore' });

    onPlatform('win32', () => reapAgentChildrenSync());

    const options = execFileSync.mock.calls[0][2] as { timeout?: number };
    expect(typeof options.timeout).toBe('number');
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('signals the process group on POSIX when the child was detached', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    registerAgentChild(fakeChild(1236), { label: 'acp:claude', detached: true });

    onPlatform('linux', () => reapAgentChildrenSync());

    // Negative pid = the whole group, which is the point of tracking `detached`.
    expect(kill).toHaveBeenCalledWith(-1236, 'SIGKILL');
  });

  it('signals just the process on POSIX when it was not detached', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    registerAgentChild(fakeChild(1237), { label: 'wcore' });

    onPlatform('linux', () => reapAgentChildrenSync());

    expect(kill).toHaveBeenCalledWith(1237, 'SIGKILL');
  });

  it('does nothing when the async sweep already cleared the map', () => {
    expect(onPlatform('win32', () => reapAgentChildrenSync())).toBe(0);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('does not signal a pid Node has already reaped', () => {
    registerAgentChild(fakeChild(1300, { exitCode: 0 }), { label: 'wcore' });

    expect(onPlatform('win32', () => reapAgentChildrenSync())).toBe(0);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('keeps going when one kill throws, and never throws itself', () => {
    // A throw inside an exit handler would replace the real exit reason.
    registerAgentChild(fakeChild(1400), { label: 'wcore' });
    registerAgentChild(fakeChild(1401), { label: 'acp:claude' });
    execFileSync.mockImplementationOnce(() => {
      throw new Error('taskkill: access denied');
    });

    const killed = onPlatform('win32', () => reapAgentChildrenSync());

    expect(killed).toBe(1);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});
