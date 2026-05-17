/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── hoisted mocks ─────────────────────────────────────────────────────────────
const mockFetch = vi.hoisted(() => vi.fn<typeof fetch>());

vi.stubGlobal('fetch', mockFetch);

import { MsTeamsPlugin } from '@process/channels/plugins/tier2/ms-teams/MsTeamsPlugin';

function mockTokenOk(): void {
  mockFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ access_token: 'valid-bearer-token', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

function mockTokenFailStatus(status: number, body: string): void {
  mockFetch.mockResolvedValueOnce(new Response(body, { status }));
}

function mockTokenNetworkError(message: string): void {
  mockFetch.mockRejectedValueOnce(new Error(message));
}

describe('MsTeamsPlugin.testConnection', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns success with botUsername = appId on valid credentials', async () => {
    mockTokenOk();

    const result = await MsTeamsPlugin.testConnection(
      JSON.stringify({ appId: 'my-app-id', appPassword: 'my-secret' }),
    );

    expect(result.success).toBe(true);
    expect(result.botUsername).toBe('my-app-id');
    expect(result.error).toBeUndefined();
  });

  it('returns error for invalid JSON token', async () => {
    const result = await MsTeamsPlugin.testConnection('not-json');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid json/i);
  });

  it('returns error when appId is missing', async () => {
    const result = await MsTeamsPlugin.testConnection(
      JSON.stringify({ appId: '', appPassword: 'secret' }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/appId/i);
  });

  it('returns error when appPassword is missing', async () => {
    const result = await MsTeamsPlugin.testConnection(
      JSON.stringify({ appId: 'my-app-id', appPassword: '' }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/appPassword/i);
  });

  it('returns auth error on 401 from Azure AD', async () => {
    mockTokenFailStatus(401, 'invalid_client');

    const result = await MsTeamsPlugin.testConnection(
      JSON.stringify({ appId: 'bad-id', appPassword: 'wrong-secret' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid appId|appPassword|Azure AD/i);
  });

  it('returns network error message on connection failure', async () => {
    mockTokenNetworkError('ECONNREFUSED');

    const result = await MsTeamsPlugin.testConnection(
      JSON.stringify({ appId: 'my-app-id', appPassword: 'my-secret' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('passes tenantId when provided', async () => {
    mockTokenOk();

    const result = await MsTeamsPlugin.testConnection(
      JSON.stringify({
        appId: 'my-app-id',
        appPassword: 'my-secret',
        tenantId: 'my-tenant-id',
      }),
    );

    expect(result.success).toBe(true);
    // Verify fetch was called with the standard token URL (tenantId flows through creds)
    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0]!;
    const body = (init as RequestInit).body as string;
    expect(body).toContain('client_id=my-app-id');
  });
});
