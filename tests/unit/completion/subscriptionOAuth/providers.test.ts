/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the pure, network-free surface of each provider flow (the parts that
 * must be exactly right for the OAuth handshake): the authorization-URL wiring
 * for Claude Max and ChatGPT, ChatGPT's JWT account-id extraction, Copilot's
 * base-URL derivation and domain normalization, and one token-refresh path with
 * `fetch` stubbed to prove response parsing and the early-refresh skew.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildAuthorizeUrl as anthropicAuthorizeUrl,
  refreshAnthropicToken,
} from '@process/services/completion/subscriptionOAuth/providers/anthropic';
import {
  buildAuthorizeUrl as chatgptAuthorizeUrl,
  getAccountId,
} from '@process/services/completion/subscriptionOAuth/providers/chatgpt';
import {
  getGitHubCopilotBaseUrl,
  normalizeDomain,
} from '@process/services/completion/subscriptionOAuth/providers/githubCopilot';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anthropic buildAuthorizeUrl', () => {
  it('encodes PKCE S256, scope, redirect and state', () => {
    const url = new URL(anthropicAuthorizeUrl('CHALLENGE', 'STATE-VERIFIER'));
    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('STATE-VERIFIER');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:53692/callback');
    expect(url.searchParams.get('scope')).toContain('user:inference');
    expect(url.searchParams.get('client_id')).toBeTruthy();
  });
});

describe('chatgpt buildAuthorizeUrl', () => {
  it('sets the Codex-specific flags and PKCE params', () => {
    const url = new URL(chatgptAuthorizeUrl('CHAL', 'ST'));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
  });
});

describe('chatgpt getAccountId', () => {
  it('extracts chatgpt_account_id from the JWT auth claim', () => {
    const payload = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' } };
    const jwt = `h.${btoa(JSON.stringify(payload))}.s`;
    expect(getAccountId(jwt)).toBe('acct-42');
  });

  it('returns null for a malformed or claimless token', () => {
    expect(getAccountId('not-a-jwt')).toBeNull();
    expect(getAccountId(`h.${btoa(JSON.stringify({ foo: 1 }))}.s`)).toBeNull();
  });
});

describe('github copilot url helpers', () => {
  it('derives the api base url from the token proxy-ep', () => {
    const token = 'tid=x;exp=1;proxy-ep=proxy.individual.githubcopilot.com;more=y';
    expect(getGitHubCopilotBaseUrl(token)).toBe('https://api.individual.githubcopilot.com');
  });

  it('falls back to the default host without a token', () => {
    expect(getGitHubCopilotBaseUrl()).toBe('https://api.individual.githubcopilot.com');
  });

  it('falls back to enterprise host when given a domain and no proxy-ep', () => {
    expect(getGitHubCopilotBaseUrl('no-proxy-here', 'ghe.acme.com')).toBe('https://copilot-api.ghe.acme.com');
  });

  it('normalizes domains and rejects garbage', () => {
    expect(normalizeDomain('https://company.ghe.com/x')).toBe('company.ghe.com');
    expect(normalizeDomain('company.ghe.com')).toBe('company.ghe.com');
    expect(normalizeDomain('   ')).toBeNull();
  });
});

describe('anthropic refreshAnthropicToken', () => {
  it('parses the token response and applies the early-refresh skew', async () => {
    const before = Date.now();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'A2', refresh_token: 'R2', expires_in: 3600 }),
      }))
    );

    const creds = await refreshAnthropicToken('R1');

    expect(creds.access).toBe('A2');
    expect(creds.refresh).toBe('R2');
    // expires = now + 3600s - 5min skew; assert it lands in the expected window.
    const lower = before + 3600_000 - 5 * 60_000;
    expect(creds.expires).toBeGreaterThanOrEqual(lower - 50);
    expect(creds.expires).toBeLessThanOrEqual(Date.now() + 3600_000 - 5 * 60_000 + 50);
  });

  it('throws with status and body on a failed refresh', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => 'invalid_grant' }))
    );
    await expect(refreshAnthropicToken('bad')).rejects.toThrow('401');
  });
});
