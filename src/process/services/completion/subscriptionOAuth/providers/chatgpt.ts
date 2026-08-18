/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * ChatGPT (OpenAI Codex subscription) OAuth flow, ported from prime-agent
 * (`oauth/openai-codex.ts`, MIT, (c) Mario Zechner + Prime Intellect).
 *
 * Authorization-code + PKCE against auth.openai.com. `state` is a random hex
 * nonce (generated via Web Crypto - no Node `crypto` import). The account id is
 * extracted from the access token's JWT claim and persisted alongside the tokens.
 *
 * Marked EXPERIMENTAL: OpenAI iterates on this flow's params
 * (`codex_cli_simplified_flow`, `originator`) and it is not covered by a live
 * end-to-end test here. Login-URL construction and token refresh are unit-tested.
 */

import { startLoopbackServer, parseAuthorizationInput } from '../callbackServer';
import { generatePkce } from '../pkce';
import type { OAuthCredentials, OAuthLoginCallbacks, SubscriptionOAuthProvider } from '../types';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = 'openid profile email offline_access';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number };
type JwtPayload = { [JWT_CLAIM_PATH]?: { chatgpt_account_id?: string }; [key: string]: unknown };

/** 16-byte random hex nonce for the OAuth `state`, via Web Crypto. */
function createState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function decodeJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1] ?? '')) as JwtPayload;
  } catch {
    return null;
  }
}

/** Extract the ChatGPT account id from the access token, or `null`. */
export function getAccountId(accessToken: string): string | null {
  const accountId = decodeJwt(accessToken)?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

/**
 * Build the authorization URL. Exposed for tests so the PKCE/scope/redirect and
 * the Codex-specific flags can be asserted without a browser.
 */
export function buildAuthorizeUrl(challenge: string, state: string, originator = 'darhai'): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', originator);
  return url.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`ChatGPT token request failed (${response.status}): ${text || response.statusText}`);
  }
  const json = (await response.json()) as TokenResponse;
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error(`ChatGPT token response missing fields: ${JSON.stringify(json)}`);
  }
  const accountId = getAccountId(json.access_token);
  if (!accountId) throw new Error('Failed to extract accountId from ChatGPT token');
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId,
  };
}

/** Refresh a ChatGPT/Codex token. Exported for direct use and testing. */
export async function refreshChatgptToken(refreshToken: string): Promise<OAuthCredentials> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID });
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePkce();
  const state = createState();
  const server = await startLoopbackServer({
    host: CALLBACK_HOST,
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    validateState: (received) => received === state,
    successMessage: 'ChatGPT холболт дууслаа. Энэ цонхыг хааж болно.',
  });

  try {
    callbacks.onAuth({
      url: buildAuthorizeUrl(challenge, state),
      instructions: 'Хөтөч нээгдэнэ. Нэвтэрч дуусгана уу.',
    });

    let code: string | undefined;
    const result = await server.waitForCode();
    if (result?.code) {
      code = result.code;
    } else {
      const input = await callbacks.onPrompt({
        message: 'Authorization code эсвэл бүтэн redirect URL-ийг буулгана уу:',
      });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) throw new Error('OAuth state mismatch');
      code = parsed.code;
    }

    if (!code) throw new Error('Missing authorization code');

    callbacks.onProgress?.('Токен солилцож байна...');
    return tokenRequest({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    });
  } finally {
    server.close();
  }
}

/** ChatGPT Plus / Pro (Codex) subscription provider. */
export const chatgptSubscriptionProvider: SubscriptionOAuthProvider = {
  id: 'chatgpt',
  name: 'ChatGPT Plus / Pro (Codex)',
  login,
  refreshToken: (credentials) => refreshChatgptToken(credentials.refresh),
  getApiKey: (credentials) => credentials.access,
};
