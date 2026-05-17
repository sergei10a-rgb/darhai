/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { GoogleChatPlugin } from '@process/channels/plugins/tier3/google-chat/GoogleChatPlugin';

// Mock google-auth-library so no real JWT minting happens in lifecycle tests.
const { mockGetClient, mockGetAccessToken } = vi.hoisted(() => ({
  mockGetClient: vi.fn(),
  mockGetAccessToken: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(function () {
    return { getClient: mockGetClient };
  }),
}));

mockGetClient.mockResolvedValue({ getAccessToken: mockGetAccessToken });
mockGetAccessToken.mockResolvedValue({ token: 'test-access-token' });

const VALID_SA_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'my-project',
  client_email: 'bot@my-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\n',
});

const validConfig = {
  id: 'google-chat_default',
  type: 'google-chat' as const,
  name: 'Google Chat',
  enabled: true,
  credentials: {
    serviceAccountJson: VALID_SA_JSON,
    audience: '123456789012',
  },
  status: 'created' as const,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('GoogleChatPlugin lifecycle', () => {
  it('starts in created status', () => {
    const plugin = new GoogleChatPlugin();
    expect(plugin.status).toBe('created');
  });

  it('transitions created → initializing → ready on initialize', async () => {
    const plugin = new GoogleChatPlugin();
    await plugin.initialize(validConfig);
    expect(plugin.status).toBe('ready');
  });

  it('transitions ready → starting → running on start', async () => {
    const plugin = new GoogleChatPlugin();
    await plugin.initialize(validConfig);
    await plugin.start();
    expect(plugin.status).toBe('running');
  });

  it('transitions running → stopping → stopped on stop', async () => {
    const plugin = new GoogleChatPlugin();
    await plugin.initialize(validConfig);
    await plugin.start();
    await plugin.stop();
    expect(plugin.status).toBe('stopped');
  });

  it('transitions to error when serviceAccountJson is missing', async () => {
    const plugin = new GoogleChatPlugin();
    await expect(
      plugin.initialize({ ...validConfig, credentials: { audience: '123' } }),
    ).rejects.toThrow(/serviceAccountJson is required/i);
    expect(plugin.status).toBe('error');
  });

  it('transitions to error when serviceAccountJson is not valid JSON', async () => {
    const plugin = new GoogleChatPlugin();
    await expect(
      plugin.initialize({ ...validConfig, credentials: { serviceAccountJson: '{bad json', audience: '123' } }),
    ).rejects.toThrow(/not valid JSON/i);
    expect(plugin.status).toBe('error');
  });

  it('transitions to error when serviceAccountJson is missing required fields', async () => {
    const plugin = new GoogleChatPlugin();
    await expect(
      plugin.initialize({
        ...validConfig,
        credentials: { serviceAccountJson: JSON.stringify({ type: 'service_account' }), audience: '123' },
      }),
    ).rejects.toThrow(/private_key.*client_email/i);
    expect(plugin.status).toBe('error');
  });

  it('declares correct capabilities', () => {
    const plugin = new GoogleChatPlugin();
    expect(plugin.capabilities).toEqual({
      canEdit: true,
      canStream: false,
      canReact: false,
      canTypingIndicator: false,
    });
  });

  it('returns null from getBotInfo before initialize', () => {
    const plugin = new GoogleChatPlugin();
    expect(plugin.getBotInfo()).toBeNull();
  });

  it('returns bot info based on service account email after initialize', async () => {
    const plugin = new GoogleChatPlugin();
    await plugin.initialize(validConfig);
    const info = plugin.getBotInfo();
    expect(info).not.toBeNull();
    expect(info?.username).toBe('bot@my-project.iam.gserviceaccount.com');
  });

  it('returns 0 active users', async () => {
    const plugin = new GoogleChatPlugin();
    await plugin.initialize(validConfig);
    expect(plugin.getActiveUserCount()).toBe(0);
  });

  it('clears bot info after stop', async () => {
    const plugin = new GoogleChatPlugin();
    await plugin.initialize(validConfig);
    await plugin.start();
    await plugin.stop();
    expect(plugin.getBotInfo()).toBeNull();
  });
});
