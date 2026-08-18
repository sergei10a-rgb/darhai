/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Anthropic (Claude Max / Pro) OAuth flow, ported from prime-agent
 * (`oauth/anthropic.ts`, MIT, (c) Mario Zechner + Prime Intellect).
 *
 * Authorization-code + PKCE against claude.ai, with a loopback callback server
 * and a manual-paste fallback for headless/remote browsers. Runs in the Electron
 * main process only (uses a Node HTTP server).
 */

import { startLoopbackServer, parseAuthorizationInput } from '../callbackServer';
import { generatePkce } from '../pkce';
import type { OAuthCredentials, OAuthLoginCallbacks, SubscriptionOAuthProvider } from '../types';

// Public OAuth client id (base64 like prime, to avoid a bare literal in grep/logs).
const CLIENT_ID = atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl');
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

/** Skew subtracted from `expires_in` so we refresh before the token truly dies. */
const EARLY_REFRESH_MS = 5 * 60 * 1000;

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number };

async function postJson(body: Record<string, string | number>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Anthropic token request failed (${response.status}): ${text}`);
  }
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`Anthropic token response was not JSON: ${text}`);
  }
}

function toCredentials(data: TokenResponse): OAuthCredentials {
  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - EARLY_REFRESH_MS,
  };
}

/**
 * Build the authorization URL for a given challenge. Exposed for tests so the
 * exact PKCE/scope/redirect wiring can be asserted without a live browser.
 * `state` is the PKCE verifier (prime's convention - the token endpoint echoes
 * it back and we compare, doubling as CSRF protection).
 */
export function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCode(code: string, state: string, verifier: string): Promise<OAuthCredentials> {
  return toCredentials(
    await postJson({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    })
  );
}

/** Refresh a Claude Max token. Exported for direct use and testing. */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
  return toCredentials(
    await postJson({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken })
  );
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePkce();
  const server = await startLoopbackServer({
    host: CALLBACK_HOST,
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    validateState: (state) => state === verifier,
    successMessage: 'Claude Max холболт дууслаа. Энэ цонхыг хааж болно.',
  });

  try {
    callbacks.onAuth({
      url: buildAuthorizeUrl(challenge, verifier),
      instructions: 'Хөтчид нэвтэрнэ үү. Хөтөч өөр төхөөрөмж дээр байвал эцсийн redirect URL-ийг энд буулгана уу.',
    });

    let code: string | undefined;
    let state: string | undefined;

    // Race the loopback callback against an optional manual paste.
    if (callbacks.onManualCodeInput) {
      let manualInput: string | undefined;
      const manualPromise = callbacks
        .onManualCodeInput()
        .then((input) => {
          manualInput = input;
          server.cancel();
        })
        .catch(() => server.cancel());

      const result = await server.waitForCode();
      if (result?.code) {
        code = result.code;
        state = result.state;
      } else if (manualInput) {
        const parsed = parseAuthorizationInput(manualInput);
        if (parsed.state && parsed.state !== verifier) throw new Error('OAuth state mismatch');
        code = parsed.code;
        state = parsed.state ?? verifier;
      }
      await manualPromise;
    } else {
      const result = await server.waitForCode();
      if (result?.code) {
        code = result.code;
        state = result.state;
      }
    }

    if (!code) {
      const input = await callbacks.onPrompt({
        message: 'Authorization code эсвэл бүтэн redirect URL-ийг буулгана уу:',
        placeholder: REDIRECT_URI,
      });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== verifier) throw new Error('OAuth state mismatch');
      code = parsed.code;
      state = parsed.state ?? verifier;
    }

    if (!code) throw new Error('Missing authorization code');

    callbacks.onProgress?.('Токен солилцож байна...');
    return exchangeCode(code, state ?? verifier, verifier);
  } finally {
    server.close();
  }
}

/** Claude Max / Pro subscription provider. */
export const anthropicSubscriptionProvider: SubscriptionOAuthProvider = {
  id: 'anthropic-max',
  name: 'Claude Max / Pro',
  login,
  refreshToken: (credentials) => refreshAnthropicToken(credentials.refresh),
  getApiKey: (credentials) => credentials.access,
};
