/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * MattermostPlugin lifecycle tests: created → initializing → ready →
 * starting → running → stopping → stopped. fetch and ws are mocked so no
 * real network connections are made.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IChannelPluginConfig } from '@process/channels/types';

// ── Hoist WS mock ─────────────────────────────────────────────────────────────
// The mock WebSocket must be constructable (not an arrow fn) and must emit
// the auth-challenge response so connectWs() resolves.

const { MockWebSocket, mockWsInstance } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  class FakeWs extends EventEmitter {
    static OPEN = 1;
    readyState = FakeWs.OPEN;
    send = vi.fn();
    close = vi.fn(() => {
      this.emit('close');
    });
    removeAllListeners = vi.fn(() => {
      EventEmitter.prototype.removeAllListeners.call(this);
      return this;
    });
  }

  const instance = new FakeWs();

  // Regular function so `new MockWebSocket()` is valid.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const MockWebSocket = vi.fn(function () {
    // Emit 'open' asynchronously after construction so the plugin can attach
    // listeners first.
    setTimeout(() => instance.emit('open'), 0);
    return instance;
  }) as unknown as { new (url: string): FakeWs } & ReturnType<typeof vi.fn>;

  return { MockWebSocket, mockWsInstance: instance };
});

vi.mock('ws', () => ({ default: MockWebSocket }));

// ── Hoist fetch mock ──────────────────────────────────────────────────────────
const { mockFetch } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  return { mockFetch };
});

vi.stubGlobal('fetch', mockFetch);

import { EventEmitter } from 'node:events';
import { MattermostPlugin } from '@process/channels/plugins/tier3/mattermost/MattermostPlugin';

// Fake /api/v4/users/me response.
const ME_RESPONSE = { id: 'bot-user-id', username: 'wayland-bot' };

// Auth-challenge success response the WS server sends back.
const WS_AUTH_OK = JSON.stringify({ seq_reply: 1, status: 'OK' });

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): IChannelPluginConfig {
  return {
    id: 'mattermost_default',
    type: 'mattermost',
    name: 'Mattermost',
    enabled: true,
    status: 'created',
    credentials: {
      serverUrl: 'https://mattermost.example.com',
      accessToken: 'test-token-abc',
      ...overrides,
    },
    createdAt: 0,
    updatedAt: 0,
  };
}

function setupHappyPath() {
  // fetch(/api/v4/users/me) returns bot identity.
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(ME_RESPONSE),
  });

  // After open event, WS send() triggers auth-ok response.
  mockWsInstance.send.mockImplementation(() => {
    setTimeout(() => mockWsInstance.emit('message', WS_AUTH_OK), 0);
  });
}

beforeEach(() => {
  MockWebSocket.mockClear();
  mockFetch.mockReset();
  mockWsInstance.send.mockReset();
  mockWsInstance.close.mockReset();
  EventEmitter.prototype.removeAllListeners.call(mockWsInstance);

  // Default: open fires, auth succeeds.
  MockWebSocket.mockImplementation(function () {
    setTimeout(() => mockWsInstance.emit('open'), 0);
    return mockWsInstance;
  });
});

describe('MattermostPlugin capabilities', () => {
  it('declares the mattermost type with edit/react/typing capabilities', () => {
    const plugin = new MattermostPlugin();
    expect(plugin.type).toBe('mattermost');
    expect(plugin.capabilities).toEqual({
      canEdit: true,
      canStream: false,
      canReact: true,
      canTypingIndicator: true,
    });
  });
});

describe('MattermostPlugin initial state', () => {
  it('starts in created status with 0 active users and no bot info', () => {
    const plugin = new MattermostPlugin();
    expect(plugin.status).toBe('created');
    expect(plugin.getActiveUserCount()).toBe(0);
    expect(plugin.getBotInfo()).toBeNull();
  });
});

describe('MattermostPlugin lifecycle: created → ready → running → stopped', () => {
  it('transitions through the full happy-path lifecycle', async () => {
    setupHappyPath();
    const plugin = new MattermostPlugin();

    await plugin.initialize(makeConfig());
    expect(plugin.status).toBe('ready');

    await plugin.start();
    expect(plugin.status).toBe('running');
    expect(plugin.getBotInfo()).toEqual({
      id: 'bot-user-id',
      username: 'wayland-bot',
      displayName: 'wayland-bot',
    });

    await plugin.stop();
    expect(plugin.status).toBe('stopped');
    expect(plugin.getBotInfo()).toBeNull();
  });

  it('transitions to error when serverUrl is missing', async () => {
    const plugin = new MattermostPlugin();
    await expect(plugin.initialize(makeConfig({ serverUrl: '' }))).rejects.toThrow(/server url/i);
    expect(plugin.status).toBe('error');
  });

  it('transitions to error when accessToken is missing', async () => {
    const plugin = new MattermostPlugin();
    await expect(
      plugin.initialize(makeConfig({ accessToken: '' })),
    ).rejects.toThrow(/access token/i);
    expect(plugin.status).toBe('error');
  });

  it('transitions to error when /users/me returns 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    const plugin = new MattermostPlugin();
    await plugin.initialize(makeConfig());
    await expect(plugin.start()).rejects.toThrow(/401/);
    expect(plugin.status).toBe('error');
  });

  it('transitions to error when WS auth fails', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(ME_RESPONSE),
    });

    mockWsInstance.send.mockImplementation(() => {
      setTimeout(
        () =>
          mockWsInstance.emit(
            'message',
            JSON.stringify({ seq_reply: 1, status: 'FAIL', error: 'Invalid token' }),
          ),
        0,
      );
    });

    const plugin = new MattermostPlugin();
    await plugin.initialize(makeConfig());
    await expect(plugin.start()).rejects.toThrow(/invalid token/i);
    expect(plugin.status).toBe('error');
  });
});

describe('MattermostPlugin handleWebhookPayload', () => {
  it('throws with a clear explanation', async () => {
    const plugin = new MattermostPlugin();
    await expect(plugin.handleWebhookPayload()).rejects.toThrow(/websocket/i);
  });
});

describe('MattermostPlugin reconnect backoff', () => {
  it('schedules a reconnect when the WS closes unexpectedly', async () => {
    setupHappyPath();
    const plugin = new MattermostPlugin();
    await plugin.initialize(makeConfig());
    await plugin.start();

    vi.useFakeTimers();
    try {
      expect(plugin.status).toBe('running');
      const constructCallsBefore = MockWebSocket.mock.calls.length;

      // Prime the next connect: open fires, send triggers auth-ok.
      MockWebSocket.mockImplementation(function () {
        setTimeout(() => mockWsInstance.emit('open'), 0);
        return mockWsInstance;
      });
      mockWsInstance.send.mockImplementation(() => {
        setTimeout(() => mockWsInstance.emit('message', WS_AUTH_OK), 0);
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(ME_RESPONSE),
      });

      // Simulate unexpected close.
      mockWsInstance.emit('close');
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.runAllTimersAsync();

      expect(MockWebSocket.mock.calls.length).toBeGreaterThan(constructCallsBefore);
    } finally {
      vi.useRealTimers();
      await plugin.stop();
    }
  });

  it('transitions to error after exceeding max reconnect attempts', async () => {
    setupHappyPath();
    const plugin = new MattermostPlugin();
    await plugin.initialize(makeConfig());
    await plugin.start();

    vi.useFakeTimers();
    try {
      // Make every reconnect attempt fail: WS emits error before auth.
      MockWebSocket.mockImplementation(function () {
        setTimeout(() => mockWsInstance.emit('error', new Error('ECONNREFUSED')), 0);
        return mockWsInstance;
      });

      // Trigger initial disconnect.
      mockWsInstance.emit('close');

      // Advance through 6 backoff windows (5s, 10s, 20s, 40s, 60s × 2) to
      // exhaust the 5-attempt limit.
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
