/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for SynologyChatPlugin.sendMessage and handleWebhookPayload.
 * fetch is mocked via vi.stubGlobal — no real HTTP.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IChannelPluginConfig } from '@process/channels/types';
import { SynologyChatPlugin } from '@process/channels/plugins/tier3/synology-chat/SynologyChatPlugin';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeConfig(): IChannelPluginConfig {
  return {
    id: 'synology-chat_default',
    type: 'synology-chat',
    name: 'Synology Chat',
    enabled: true,
    status: 'created',
    credentials: {
      incomingUrl: 'https://nas.example.com/webhook',
      incomingToken: 'secret-token',
    },
    createdAt: 0,
    updatedAt: 0,
  };
}

async function startPlugin(): Promise<SynologyChatPlugin> {
  const plugin = new SynologyChatPlugin();
  await plugin.initialize(makeConfig());
  await plugin.start();
  return plugin;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response('{"success":true}', { status: 200 }));
});

describe('SynologyChatPlugin.sendMessage — happy paths', () => {
  it('POSTs form-encoded payload to the incomingUrl', async () => {
    const plugin = await startPlugin();
    await plugin.sendMessage('42', { type: 'text', text: 'hello' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://nas.example.com/webhook');
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(init.method).toBe('POST');

    // Body should be form-encoded with payload containing the text.
    const bodyStr = init.body as string;
    const params = new URLSearchParams(bodyStr);
    const inner = JSON.parse(params.get('payload')!) as { text: string; user_ids: number[] };
    expect(inner.text).toBe('hello');
    expect(inner.user_ids).toEqual([42]);

    await plugin.stop();
  });

  it('returns a synology-chat prefixed synthetic message id', async () => {
    const plugin = await startPlugin();
    const id = await plugin.sendMessage('7', { type: 'text', text: 'hi' });
    expect(id).toMatch(/^synology-chat:7:\d+$/);
    await plugin.stop();
  });

  it('throws when plugin is not initialized', async () => {
    const plugin = new SynologyChatPlugin();
    await expect(
      plugin.sendMessage('1', { type: 'text', text: 'hello' }),
    ).rejects.toThrow(/not initialized/i);
  });

  it('throws when the server returns a non-200 response', async () => {
    mockFetch.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    const plugin = await startPlugin();
    await expect(
      plugin.sendMessage('1', { type: 'text', text: 'hello' }),
    ).rejects.toThrow(/403/);
    await plugin.stop();
  });

  it('throws when fetch rejects (network error)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const plugin = await startPlugin();
    await expect(
      plugin.sendMessage('1', { type: 'text', text: 'hello' }),
    ).rejects.toThrow(/ECONNREFUSED/);
    await plugin.stop();
  });
});

describe('SynologyChatPlugin.handleWebhookPayload — inbound message emission', () => {
  it('emits a unified message for a valid payload', async () => {
    const plugin = await startPlugin();

    const received: unknown[] = [];
    plugin.onMessage(async (msg) => { received.push(msg); });

    await plugin.handleWebhookPayload(
      { user_id: '5', username: 'alice', text: 'hello bot', channel_id: '10' },
      {},
      'synology-chat_default',
    );

    expect(received.length).toBe(1);
    const msg = received[0] as { platform: string; content: { text: string }; chatId: string };
    expect(msg.platform).toBe('synology-chat');
    expect(msg.content.text).toBe('hello bot');
    expect(msg.chatId).toBe('10');

    await plugin.stop();
  });

  it('tracks senders in the active user set', async () => {
    const plugin = await startPlugin();
    plugin.onMessage(async () => undefined);

    expect(plugin.getActiveUserCount()).toBe(0);

    await plugin.handleWebhookPayload(
      { user_id: '5', text: 'hi', channel_id: '1' },
      {},
      'synology-chat_default',
    );

    expect(plugin.getActiveUserCount()).toBe(1);
    await plugin.stop();
  });

  it('drops payloads missing user_id without throwing', async () => {
    const plugin = await startPlugin();
    const received: unknown[] = [];
    plugin.onMessage(async (msg) => { received.push(msg); });

    await expect(
      plugin.handleWebhookPayload({ text: 'hi' }, {}, 'synology-chat_default'),
    ).resolves.not.toThrow();

    expect(received.length).toBe(0);
    await plugin.stop();
  });

  it('drops payloads missing text without throwing', async () => {
    const plugin = await startPlugin();
    const received: unknown[] = [];
    plugin.onMessage(async (msg) => { received.push(msg); });

    await expect(
      plugin.handleWebhookPayload({ user_id: '5' }, {}, 'synology-chat_default'),
    ).resolves.not.toThrow();

    expect(received.length).toBe(0);
    await plugin.stop();
  });
});
