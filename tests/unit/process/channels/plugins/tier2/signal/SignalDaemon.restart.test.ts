/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * SignalDaemon restart / backoff behaviour — verifies:
 *   - unexpected exit triggers a restart after backoff delay
 *   - restart counter increments correctly
 *   - after MAX_RESTART_ATTEMPTS status transitions to 'error'
 *   - stop() cancels a pending restart
 *   - inbound JSON-RPC notifications fire message handlers
 *
 * Uses real timers (vi.useFakeTimers only where needed) and synchronous child
 * exit emission to avoid setImmediate / setTimeout interaction issues.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoist spawn mock ──────────────────────────────────────────────────────────

const { mockSpawn, getChildren } = vi.hoisted(() => {
  type FakeStream = EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };

  type FakeChild = EventEmitter & {
    stdin: FakeStream;
    stdout: FakeStream;
    stderr: FakeStream;
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    /** Synchronously fire the exit event (avoids setImmediate/fake-timer issues). */
    exitSync: (code: number | null, signal: NodeJS.Signals | null) => void;
  };

  const children: FakeChild[] = [];

  function makeStream(): FakeStream {
    const s = new EventEmitter() as FakeStream;
    s.setEncoding = vi.fn();
    s.write = vi.fn((_d: unknown, cb?: (e?: Error) => void) => {
      cb?.();
      return true;
    });
    return s;
  }

  const mockSpawn = vi.fn(function (): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdin = makeStream();
    child.stdout = makeStream();
    child.stderr = makeStream();
    child.pid = 10000 + children.length;
    child.killed = false;
    child.exitSync = (code, signal) => {
      child.emit('exit', code, signal);
    };
    // kill() fires exit synchronously so stop() resolves without needing timers.
    child.kill = vi.fn((sig: string) => {
      if (!child.killed) {
        child.killed = true;
        child.exitSync(null, (sig ?? 'SIGTERM') as NodeJS.Signals);
      }
    });
    children.push(child);
    return child;
  });

  return {
    mockSpawn,
    getChildren: () => children,
  };
});

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  execFile: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/fake/app',
    getPath: () => '/fake/userData',
  },
}));

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => false) },
  existsSync: vi.fn(() => false),
}));

import { SignalDaemon } from '@process/channels/plugins/tier2/signal/SignalDaemon';

beforeEach(() => {
  // Clear the shared children array.
  getChildren().splice(0);
  mockSpawn.mockClear();
  // Disable jitter so deterministic backoff assertions (5_000 / 10_000) still
  // hold. The jitter was added per gemini MED1 2026-05-18; tests pin it to 0.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SignalDaemon restart behaviour', () => {
  it('spawns signal-cli with daemon + --http args on start()', async () => {
    const daemon = new SignalDaemon({ phoneNumber: '+14155551234' });
    await daemon.start();
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).toContain('daemon');
    expect(args).toContain('--http');
    expect(args).toContain('+14155551234');
    await daemon.stop();
  });

  it('status is running immediately after start()', async () => {
    const daemon = new SignalDaemon({ phoneNumber: '+14155551234' });
    await daemon.start();
    expect(daemon.status).toBe('running');
    await daemon.stop();
  });

  it('status is stopped after stop()', async () => {
    const daemon = new SignalDaemon({ phoneNumber: '+14155551234' });
    await daemon.start();
    await daemon.stop();
    expect(daemon.status).toBe('stopped');
  });

  it('schedules a restart after unexpected exit (first attempt: 5 s)', async () => {
    vi.useFakeTimers();
    const daemon = new SignalDaemon({ phoneNumber: '+14155551234' });
    await daemon.start();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Simulate unexpected exit synchronously.
    getChildren()[0].exitSync(1, null);

    expect(daemon.status).toBe('starting');

    // Advance past the 5s initial backoff.
    await vi.advanceTimersByTimeAsync(5_001);
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    // Stop with real timers so killChild resolves immediately.
    vi.useRealTimers();
    await daemon.stop();
  });

  it('doubles backoff on successive failures (5s → 10s)', async () => {
    vi.useFakeTimers();
    const daemon = new SignalDaemon({ phoneNumber: '+14155551234' });
    await daemon.start();

    // First exit → restart after 5s.
    getChildren()[0].exitSync(1, null);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    // Second exit → restart after 10s.
    getChildren()[1].exitSync(1, null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockSpawn).toHaveBeenCalledTimes(2); // not yet
    await vi.advanceTimersByTimeAsync(5_001);
    expect(mockSpawn).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
    await daemon.stop();
  });

  it('transitions to error after exceeding MAX_RESTART_ATTEMPTS (5)', async () => {
    vi.useFakeTimers();
    const daemon = new SignalDaemon({ phoneNumber: '+14155551234' });
    await daemon.start();

    // The daemon allows MAX_RESTART_ATTEMPTS=5 restarts.
    // Spawn sequence: #1 (initial) → exit → #2 → exit → ... → #6 → exit → error.
    // 6 exits total exhaust the budget.
    for (let i = 0; i < 6; i++) {
      getChildren()[i].exitSync(1, null);
      // Advance past the current backoff so the next restart fires (if any).
      await vi.advanceTimersByTimeAsync(65_000);
    }

    expect(daemon.status).toBe('error');
    // original spawn + 5 retry spawns = 6 total
    expect(mockSpawn).toHaveBeenCalledTimes(6);
    vi.useRealTimers();
  });

  it('stop() cancels a pending restart and does not spawn again', async () => {
    vi.useFakeTimers();
    const daemon = new SignalDaemon({ phoneNumber: '+14155551234' });
    await daemon.start();

    getChildren()[0].exitSync(1, null);
    expect(daemon.status).toBe('starting');

    // Stop before the 5s fires.
    vi.useRealTimers();
    await daemon.stop();

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);

    // Only the original spawn — no restart.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(daemon.status).toBe('stopped');
    vi.useRealTimers();
  });

  it('fires message handlers for inbound receive notifications', async () => {
    const daemon = new SignalDaemon({ phoneNumber: '+14155551234' });
    const handler = vi.fn();
    daemon.onMessage(handler);
    await daemon.start();

    const notification =
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'receive',
        params: {
          envelope: {
            source: '+12125550100',
            timestamp: 1_700_000_000_000,
            dataMessage: { message: 'Test inbound', timestamp: 1_700_000_000_000 },
          },
        },
      }) + '\n';

    getChildren()[0].stdout.emit('data', notification);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      envelope: { source: '+12125550100' },
    });

    await daemon.stop();
  });

  it('offMessage removes a handler so it no longer fires', async () => {
    const daemon = new SignalDaemon({ phoneNumber: '+14155551234' });
    const handler = vi.fn();
    daemon.onMessage(handler);
    daemon.offMessage(handler);
    await daemon.start();

    const notification =
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'receive',
        params: { envelope: { source: '+12125550100' } },
      }) + '\n';

    getChildren()[0].stdout.emit('data', notification);
    expect(handler).not.toHaveBeenCalled();

    await daemon.stop();
  });
});
