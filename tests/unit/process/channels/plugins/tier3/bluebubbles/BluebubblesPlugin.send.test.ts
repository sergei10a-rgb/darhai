/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * BluebubblesPlugin send tests — sendMessage, sendReaction, sendTypingIndicator,
 * and the reconnect backoff schedule. fetch and socket.io-client are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IChannelPluginConfig, IUnifiedOutgoingMessage } from '@process/channels/types';

// ── Hoist Socket.IO mock ──────────────────────────────────────────────────────

const { mockIo, mockSocketInstance } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  class FakeSocket extends EventEmitter {
    disconnect = vi.fn();
    removeAllListeners = vi.fn(() => {
      EventEmitter.prototype.removeAllListeners.call(this);
      return this;
    });
  }

  const instance = new FakeSocket();
  const mockIo = vi.fn(function () {
    setTimeout(() => instance.emit('connect'), 0);
    return instance;
  });

  return { mockIo, mockSocketInstance: instance };
});

vi.mock('socket.io-client', () => ({ io: mockIo }));

// ── Hoist fetch mock ──────────────────────────────────────────────────────────

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);

import { EventEmitter } from 'node:events';
import { BluebubblesPlugin } from '@process/channels/plugins/tier3/bluebubbles/BluebubblesPlugin';

const SERVER_INFO_OK = { status: 200, data: { server_address: 'bb.example.com' } };
const SEND_RESPONSE = { status: 200, data: { guid: 'sent-guid-abc' } };

const CHAT_ID = 'iMessage;-;+14155550100';

function makeConfig(): IChannelPluginConfig {
  return {
    id: 'bluebubbles_default',
    type: 'bluebubbles',
    name: 'BlueBubbles',
    enabled: true,
    status: 'created',
    credentials: { serverUrl: 'https://bb.example.com:1234', password: 'secret123' },
    createdAt: 0,
    updatedAt: 0,
  };
}

function outgoing(text: string): IUnifiedOutgoingMessage {
  return { type: 'text', text };
}

async function startPlugin(): Promise<BluebubblesPlugin> {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(SERVER_INFO_OK),
  });
  const plugin = new BluebubblesPlugin();
  await plugin.initialize(makeConfig());
  await plugin.start();
  return plugin;
}

beforeEach(() => {
  mockIo.mockReset();
  mockFetch.mockReset();
  mockSocketInstance.disconnect.mockReset();
  mockSocketInstance.removeAllListeners.mockReset();
  EventEmitter.prototype.removeAllListeners.call(mockSocketInstance);

  mockIo.mockImplementation(function () {
    setTimeout(() => mockSocketInstance.emit('connect'), 0);
    return mockSocketInstance;
  });
});

// ── sendMessage ───────────────────────────────────────────────────────────────

describe('BluebubblesPlugin.sendMessage', () => {
  it('POSTs to /api/v1/message/text and returns the guid', async () => {
    const plugin = await startPlugin();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(SEND_RESPONSE),
    });

    const id = await plugin.sendMessage(CHAT_ID, outgoing('Hello iMessage'));
    expect(id).toBe('sent-guid-abc');

    const [url, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/api/v1/message/text');
    expect(url).toContain('password=secret123');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.chatGuid).toBe(CHAT_ID);
    expect(body.message).toBe('Hello iMessage');

    await plugin.stop();
  });

  it('returns empty string for empty text', async () => {
    const plugin = await startPlugin();
    const id = await plugin.sendMessage(CHAT_ID, outgoing(''));
    expect(id).toBe('');
    await plugin.stop();
  });

  it('throws when server returns non-ok', async () => {
    const plugin = await startPlugin();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal error'),
    });

    await expect(plugin.sendMessage(CHAT_ID, outgoing('Hi'))).rejects.toThrow(/500/);
    await plugin.stop();
  });

  it('throws when plugin is not initialized', async () => {
    const plugin = new BluebubblesPlugin();
    await expect(plugin.sendMessage(CHAT_ID, outgoing('Hi'))).rejects.toThrow(/not initialized/i);
  });
});

// ── sendReaction ──────────────────────────────────────────────────────────────

describe('BluebubblesPlugin.sendReaction', () => {
  it('POSTs to /api/v1/message/react with correct tapback payload', async () => {
    const plugin = await startPlugin();

    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 200 }) });

    await plugin.sendReaction(CHAT_ID, 'msg-guid-xyz', '❤️');

    const [url, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/api/v1/message/react');
    expect(url).toContain('password=secret123');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.chatGuid).toBe(CHAT_ID);
    expect(body.selectedMessageGuid).toBe('msg-guid-xyz');
    expect(body.reaction).toBe('love');
    expect(body.partIndex).toBe(0);

    await plugin.stop();
  });

  it('throws for an unsupported tapback emoji', async () => {
    const plugin = await startPlugin();
    await expect(plugin.sendReaction(CHAT_ID, 'msg-guid', '🎉')).rejects.toThrow(/unsupported/i);
    await plugin.stop();
  });

  it('throws when react endpoint returns non-ok', async () => {
    const plugin = await startPlugin();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad request'),
    });

    await expect(plugin.sendReaction(CHAT_ID, 'msg-guid', '👍')).rejects.toThrow(/400/);
    await plugin.stop();
  });
});

// ── sendTypingIndicator ───────────────────────────────────────────────────────

describe('BluebubblesPlugin.sendTypingIndicator', () => {
  it('POSTs to /api/v1/chat/{chatGuid}/typing', async () => {
    const plugin = await startPlugin();

    mockFetch.mockResolvedValueOnce({ ok: true });

    await plugin.sendTypingIndicator(CHAT_ID);

    const [url, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/api/v1/chat/');
    expect(url).toContain('typing');
    expect(opts.method).toBe('POST');

    await plugin.stop();
  });

  it('swallows errors from the typing endpoint', async () => {
    const plugin = await startPlugin();

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    // Should not throw.
    await expect(plugin.sendTypingIndicator(CHAT_ID)).resolves.toBeUndefined();

    await plugin.stop();
  });
});

// ── Reconnect backoff ─────────────────────────────────────────────────────────

describe('BluebubblesPlugin reconnect backoff', () => {
  it('schedules a reconnect when the socket disconnects unexpectedly', async () => {
    const plugin = await startPlugin();

    vi.useFakeTimers();
    try {
      const callsBefore = mockIo.mock.calls.length;

      // Prime the next connect.
      mockIo.mockImplementation(function () {
        setTimeout(() => mockSocketInstance.emit('connect'), 0);
        return mockSocketInstance;
      });
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(SERVER_INFO_OK) });

      // Simulate unexpected disconnect.
      mockSocketInstance.emit('disconnect', 'transport close');
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.runAllTimersAsync();

      expect(mockIo.mock.calls.length).toBeGreaterThan(callsBefore);
    } finally {
      vi.useRealTimers();
      await plugin.stop();
    }
  });

  it('transitions to error after exhausting max reconnect attempts', async () => {
    const plugin = await startPlugin();

    vi.useFakeTimers();
    try {
      // Every reconnect attempt fails with connect_error.
      mockIo.mockImplementation(function () {
        setTimeout(
          () => mockSocketInstance.emit('connect_error', new Error('ECONNREFUSED')),
          0,
        );
        return mockSocketInstance;
      });

      // Trigger first disconnect.
      mockSocketInstance.emit('disconnect', 'transport close');

      // Advance past 5 backoff windows (5s, 10s, 20s, 40s, 60s).
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.runAllTimersAsync();
      }

      expect(plugin.status).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── new-message event routing ─────────────────────────────────────────────────

describe('BluebubblesPlugin new-message event routing', () => {
  it('emits a unified message to the handler when new-message fires', async () => {
    const plugin = await startPlugin();

    const received: unknown[] = [];
    plugin.onMessage(async (msg) => {
      received.push(msg);
    });

    mockSocketInstance.emit('new-message', {
      guid: 'inbound-1',
      text: 'Hey there',
      isFromMe: false,
      handle: { address: '+14155550300', displayName: 'Bob' },
      chatGuid: 'iMessage;-;+14155550300',
      dateCreated: 1_700_000_000_000,
    });

    // Let the async emitMessage settle.
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    const msg = received[0] as { content: { text: string } };
    expect(msg.content.text).toBe('Hey there');

    await plugin.stop();
  });

  it('drops own messages (isFromMe=true) without emitting', async () => {
    const plugin = await startPlugin();

    const received: unknown[] = [];
    plugin.onMessage(async (msg) => {
      received.push(msg);
    });

    mockSocketInstance.emit('new-message', {
      guid: 'own-1',
      text: 'I sent this',
      isFromMe: true,
      handle: { address: '+14155550301' },
      chatGuid: 'iMessage;-;+14155550301',
    });

    await new Promise<void>((r) => setTimeout(r, 0));

    expect(received).toHaveLength(0);

    await plugin.stop();
  });
});
