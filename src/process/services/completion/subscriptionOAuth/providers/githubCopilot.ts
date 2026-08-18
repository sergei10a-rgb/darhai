/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * GitHub Copilot OAuth flow, ported from prime-agent (`oauth/github-copilot.ts`,
 * MIT, (c) Mario Zechner + Prime Intellect).
 *
 * Uses GitHub's device-code flow (no loopback server): the user enters a code at
 * github.com/login/device, then the long-lived GitHub token is exchanged for a
 * short-lived Copilot token on every refresh. `credentials.refresh` holds the
 * GitHub token; `credentials.access` holds the current Copilot token, whose
 * base URL is embedded in its `proxy-ep=` field.
 *
 * Marked EXPERIMENTAL: model-policy enablement (needed for some Claude/Grok
 * models on Copilot) is intentionally omitted - it depends on a model catalog
 * this port does not carry. Login, refresh, and base-URL derivation are covered.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, SubscriptionOAuthProvider } from '../types';

const CLIENT_ID = atob('SXYxLmI1MDdhMDhjODdlY2ZlOTg=');
const EARLY_REFRESH_MS = 5 * 60 * 1000;
const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;

const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const;

/** Extra field persisted for GitHub Enterprise users. */
type CopilotCredentials = OAuthCredentials & { enterpriseUrl?: string };

/** Normalize a raw domain/URL into a hostname, or `null` when invalid. */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function getUrls(domain: string): { deviceCodeUrl: string; accessTokenUrl: string; copilotTokenUrl: string } {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
  };
}

/**
 * Derive the Copilot API base URL from a Copilot token's `proxy-ep=` field
 * (`proxy.x` -> `api.x`), falling back to enterprise/default hosts. Exported for
 * tests and for the completion-layer wiring.
 */
export function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
  if (token) {
    const match = token.match(/proxy-ep=([^;]+)/);
    if (match) return `https://${match[1].replace(/^proxy\./, 'api.')}`;
  }
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return 'https://api.individual.githubcopilot.com';
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
};

async function startDeviceFlow(domain: string): Promise<DeviceCodeResponse> {
  const data = (await fetchJson(getUrls(domain).deviceCodeUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': COPILOT_HEADERS['User-Agent'],
    },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }),
  })) as Partial<DeviceCodeResponse>;

  if (
    typeof data.device_code !== 'string' ||
    typeof data.user_code !== 'string' ||
    typeof data.verification_uri !== 'string' ||
    typeof data.interval !== 'number' ||
    typeof data.expires_in !== 'number'
  ) {
    throw new Error('Invalid device code response');
  }
  return data as DeviceCodeResponse;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Login cancelled'));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new Error('Login cancelled'));
      },
      { once: true }
    );
  });
}

async function pollForGitHubAccessToken(
  domain: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresIn: number,
  signal?: AbortSignal
): Promise<string> {
  const url = getUrls(domain).accessTokenUrl;
  const deadline = Date.now() + expiresIn * 1000;
  let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));
  let multiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;

  // Device-code polling is inherently sequential: each attempt must wait for the
  // previous one's interval + response before the next, so `Promise.all` does not
  // apply here.
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Login cancelled');
    const waitMs = Math.min(Math.ceil(intervalMs * multiplier), deadline - Date.now());
    await abortableSleep(waitMs, signal);

    const raw = (await fetchJson(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': COPILOT_HEADERS['User-Agent'],
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })) as Record<string, unknown>;

    if (typeof raw.access_token === 'string') return raw.access_token;

    if (typeof raw.error === 'string') {
      if (raw.error === 'authorization_pending') continue;
      if (raw.error === 'slow_down') {
        intervalMs = typeof raw.interval === 'number' && raw.interval > 0 ? raw.interval * 1000 : intervalMs + 5000;
        multiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
        continue;
      }
      throw new Error(`Device flow failed: ${raw.error}`);
    }
  }
  /* eslint-enable no-await-in-loop */
  throw new Error('Device flow timed out');
}

/**
 * Exchange a GitHub access token for a Copilot token. This IS the refresh path -
 * the GitHub token is long-lived, the Copilot token expires hourly. Exported for
 * direct use and testing.
 */
export async function refreshGitHubCopilotToken(
  githubToken: string,
  enterpriseDomain?: string
): Promise<CopilotCredentials> {
  const domain = enterpriseDomain || 'github.com';
  const raw = (await fetchJson(getUrls(domain).copilotTokenUrl, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${githubToken}`, ...COPILOT_HEADERS },
  })) as Record<string, unknown>;

  if (typeof raw.token !== 'string' || typeof raw.expires_at !== 'number') {
    throw new Error('Invalid Copilot token response');
  }
  return {
    refresh: githubToken,
    access: raw.token,
    expires: raw.expires_at * 1000 - EARLY_REFRESH_MS,
    enterpriseUrl: enterpriseDomain,
  };
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const input = await callbacks.onPrompt({
    message: 'GitHub Enterprise URL/домэйн (github.com бол хоосон орхино):',
    placeholder: 'company.ghe.com',
    allowEmpty: true,
  });
  if (callbacks.signal?.aborted) throw new Error('Login cancelled');

  const trimmed = input.trim();
  const enterpriseDomain = normalizeDomain(input);
  if (trimmed && !enterpriseDomain) throw new Error('Invalid GitHub Enterprise URL/domain');
  const domain = enterpriseDomain || 'github.com';

  const device = await startDeviceFlow(domain);
  callbacks.onAuth({ url: device.verification_uri, instructions: `Код оруулна уу: ${device.user_code}` });

  const githubToken = await pollForGitHubAccessToken(
    domain,
    device.device_code,
    device.interval,
    device.expires_in,
    callbacks.signal
  );
  callbacks.onProgress?.('Copilot токен авч байна...');
  return refreshGitHubCopilotToken(githubToken, enterpriseDomain ?? undefined);
}

/** GitHub Copilot subscription provider. */
export const githubCopilotSubscriptionProvider: SubscriptionOAuthProvider = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  login,
  refreshToken: (credentials) =>
    refreshGitHubCopilotToken(credentials.refresh, (credentials as CopilotCredentials).enterpriseUrl),
  getApiKey: (credentials) => credentials.access,
};
