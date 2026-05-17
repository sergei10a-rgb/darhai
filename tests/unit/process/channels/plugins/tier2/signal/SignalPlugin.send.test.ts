/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * SignalPlugin.send — sendMessage dispatches the correct RPC params and
 * returns a stable message id (timestamp string).  Multi-chunk sends are
 * tested too.
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoist spawn mock ──────────────────────────────────────────────────────────

const { mockSpawn, triggerStdout } = vi.hoisted(() => {
  type FakeStream = EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };

  function makeStream(): FakeStream {
    const s = new EventEmitter() as FakeStream;
    s.setEncoding = vi.fn();
    s.write = vi.fn();
    return s;
  }

  type Child = EventEmitter & {
    stdin: FakeStream;
    stdout: FakeStream;
    stderr: FakeStream;
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };

  let lastStdin: FakeStream | null = null;
  let lastStdout: FakeStream | null = null;

  const mockSpawn = vi.fn(function (): Child {
    const child = new EventEmitter() as Child;
    child.stdin = makeStream();
    child.stdout = makeStream();
    child.stderr = makeStream();
    child.stdout.setEncoding = vi.fn();
    child.pid = 99;
    child.killed = false;
    child.kill = vi.fn((sig: string) => {
      child.killed = true;
      setImmediate(() => child.emit('exit', null, sig ?? 'SIGTERM'));
    });
    lastStdin = child.stdin;
    lastStdout = child.stdout;

    // Auto-reply to every RPC write with a successful response.
    child.stdin.write = vi.fn(function (data: string, cb?: (err?: Error) => void) {
      cb?.();
      // Parse what was written and echo back a result with a timestamp.
      try {
        const frame = JSON.parse(data.replace(/\n$/, '')) as { id: number };
        const reply = JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { timestamp: 1_700_000_001_000 } }) + '\n';
        setImmediate(() => lastStdout!.emit('data', reply));
      } catch { /* ignore malformed */ }
      return true;
    });

    return child;
  });

  return {
    mockSpawn,
    triggerStdout: (data: string) => lastStdout?.emit('data', data),
  };
});

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  execFile: vi.fn((_f: unknown, _a: unknown, _o: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
    cb(null, 'signal-cli 0.13.5', '');
  }),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app', getPath: () => '/fake/userData' },
}));

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => false) },
  existsSync: vi.fn(() => false),
}));

import type { IChannelPluginConfig } from '@process/channels/types';
import { SignalPlugin } from '@process/channels/plugins/tier2/signal/SignalPlugin';

function makeConfig(): IChannelPluginConfig {
  return {
    id: 'signal_default',
    type: 'signal',
    name: 'Signal',
    enabled: true,
    status: 'created',
    credentials: { phoneNumber: '+14155551234' },
    createdAt: 0,
    updatedAt: 0,
  };
}

beforeEach(() => {
  mockSpawn.mockClear();
});

describe('SignalPlugin.sendMessage', () => {
  it('returns the daemon timestamp as message id for a short message', async () => {
    const p = new SignalPlugin();
    await p.initialize(makeConfig());
    await p.start();

    const id = await p.sendMessage('+12125550100', { type: 'text', text: 'Hello' });
    expect(id).toBe('1700000001000');

    await p.stop();
  });

  it('sends to recipient array for E.164 chatId', async () => {
    const p = new SignalPlugin();
    await p.initialize(makeConfig());
    await p.start();

    await p.sendMessage('+12125550100', { type: 'text', text: 'Hello' });

    // Inspect the RPC frame written to stdin.
    const writeCalls = (mockSpawn.mock.results[0].value.stdin.write as ReturnType<typeof vi.fn>).mock.calls;
    const frame = JSON.parse(writeCalls[0][0] as string) as {
      method: string;
      params: { recipient?: string[]; message: string };
    };
    expect(frame.method).toBe('send');
    expect(frame.params.recipient).toEqual(['+12125550100']);
    expect(frame.params.message).toBe('Hello');

    await p.stop();
  });

  it('sends to groupId field for group: chatId', async () => {
    const p = new SignalPlugin();
    await p.initialize(makeConfig());
    await p.start();

    await p.sendMessage('group:abc123==', { type: 'text', text: 'Group msg' });

    const writeCalls = (mockSpawn.mock.results[0].value.stdin.write as ReturnType<typeof vi.fn>).mock.calls;
    const frame = JSON.parse(writeCalls[0][0] as string) as {
      params: { groupId?: string; recipient?: string[] };
    };
    expect(frame.params.groupId).toBe('abc123==');
    expect(frame.params.recipient).toBeUndefined();

    await p.stop();
  });

  it('throws when message body is empty', async () => {
    const p = new SignalPlugin();
    await p.initialize(makeConfig());
    await p.start();

    await expect(p.sendMessage('+12125550100', { type: 'text', text: '' })).rejects.toThrow(/empty/i);

    await p.stop();
  });

  it('sends multiple RPC frames for long text (chunking)', async () => {
    const p = new SignalPlugin();
    await p.initialize(makeConfig());
    await p.start();

    // Build a text that is just over 2× the chunk limit so it splits into 3.
    const longText = ('word ').repeat(900).trim(); // ~4500 chars
    await p.sendMessage('+12125550100', { type: 'text', text: longText });

    const writeCalls = (mockSpawn.mock.results[0].value.stdin.write as ReturnType<typeof vi.fn>).mock.calls;
    // At least 2 RPC writes expected (text was chunked).
    expect(writeCalls.length).toBeGreaterThanOrEqual(2);

    await p.stop();
  });

  it('throws when daemon is not running', async () => {
    const p = new SignalPlugin();
    await expect(p.sendMessage('+12125550100', { type: 'text', text: 'hi' })).rejects.toThrow(/daemon/i);
  });
});
