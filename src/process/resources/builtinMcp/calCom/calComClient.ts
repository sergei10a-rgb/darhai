/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The single network primitive of the Cal.com MCP server.
 *
 * Only GET is implemented, on purpose. There is no `post`, `patch` or `delete`
 * helper anywhere in this bundle, so "the server cannot write to your calendar"
 * is a property of the code rather than a promise in a doc: adding a write tool
 * later would require adding an HTTP verb first, which is a visible diff.
 *
 * Three things it must get right:
 *   1. **Version header.** Cal.com routes are selected by `cal-api-version`;
 *      the wrong value returns a bare 404 that looks like a dead endpoint. See
 *      `types.ts` for the live probe that pinned each one.
 *   2. **Never leak the key.** The bearer token is read once from env and never
 *      returned, logged, or embedded in an error. Every error string goes
 *      through `redactSecrets`.
 *   3. **Never hang.** Every request carries an AbortController deadline.
 */

import {
  CAL_API_KEY_ENV,
  CAL_API_VERSIONS,
  CAL_BASE_URL_ENV,
  CAL_DEFAULT_BASE_URL,
  CalComError,
  redactSecrets,
  type CalEnvelope,
  type CalRoute,
} from './types';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 60_000;
/** A calendar answer past this size is a misconfiguration, not a schedule. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export const CAL_USER_AGENT = 'Darhai/1.0 (+https://github.com/sergei10a-rgb/darhai) cal-com-mcp';

/** Injected so every handler is testable without touching the network. */
export type CalHttpGet = (
  route: CalRoute,
  pathAndQuery: string,
  timeoutMs: number
) => Promise<{ status: number; body: unknown }>;

export type CalClientConfig = {
  /** Bearer token. Empty when the user has not configured one yet. */
  apiKey: string;
  /** Absolute base URL, no trailing slash. */
  baseUrl: string;
};

/**
 * Read configuration out of the environment.
 *
 * A missing key is NOT fatal here: the server still starts and still answers
 * `tools/list`, then reports a precise setup error at call time. Exiting
 * instead would make a configuration gap indistinguishable from a broken
 * bundle - the exact confusion the build guards exist to remove.
 */
export function readCalConfig(env: NodeJS.ProcessEnv = process.env): CalClientConfig {
  const apiKey = (env[CAL_API_KEY_ENV] ?? '').trim();
  const rawBase = (env[CAL_BASE_URL_ENV] ?? '').trim();
  return { apiKey, baseUrl: normalizeBaseUrl(rawBase) };
}

/**
 * Normalise a user-supplied base URL. Self-hosted Cal.com is commonly given as
 * `https://cal.example.com` (no `/v2`) or with a trailing slash; both must work
 * without the user having to know our path-joining rules.
 */
export function normalizeBaseUrl(raw: string): string {
  if (!raw) return CAL_DEFAULT_BASE_URL;
  let base = raw.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  if (!/\/v\d+$/.test(base)) base = `${base}/v2`;
  return base;
}

/** Build the real HTTP GET used in production. */
export function createCalHttpGet(config: CalClientConfig): CalHttpGet {
  return async (route, pathAndQuery, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${config.baseUrl}${pathAndQuery}`, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          // `/v2/slots` is public, so an empty key must still produce a real
          // request rather than a client-side refusal.
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          'cal-api-version': CAL_API_VERSIONS[route],
          accept: 'application/json',
          'user-agent': CAL_USER_AGENT,
        },
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES) {
        throw new CalComError(`Cal.com returned ${bytes.byteLength} bytes, over the ${MAX_BODY_BYTES}-byte cap`);
      }
      const text = bytes.toString('utf8');
      return { status: response.status, body: text.length > 0 ? safeJson(text) : null };
    } catch (error) {
      throw toCalError(error, config.baseUrl, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Perform one GET and unwrap Cal.com's `{ status, data }` envelope.
 * Any non-2xx becomes a {@link CalComError} whose message names the cause in
 * words a user can act on ("your API key was rejected"), never a raw dump.
 */
export async function calGet<T>(
  get: CalHttpGet,
  route: CalRoute,
  pathAndQuery: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const budget = Math.min(Math.max(Math.trunc(timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
  const { status, body } = await get(route, pathAndQuery, budget);
  const envelope = (body ?? {}) as CalEnvelope<T>;

  if (status >= 200 && status < 300) {
    return (envelope.data ?? (envelope as unknown as T)) as T;
  }

  throw new CalComError(describeHttpFailure(status, envelope, pathAndQuery), status);
}

/**
 * Turn an HTTP failure into a sentence that tells the user what to change.
 *
 * The 404 branch is not cosmetic: a wrong `cal-api-version` is indistinguishable
 * from a dead route in Cal.com's response, and that ambiguity cost real
 * debugging time when this server was written, so the message says so out loud.
 */
function describeHttpFailure(status: number, envelope: CalEnvelope<unknown>, pathAndQuery: string): string {
  const upstream = redactSecrets(envelope.error?.message ?? envelope.error?.code ?? '');
  const path = pathAndQuery.split('?')[0];

  if (status === 401 || status === 403) {
    return (
      `Cal.com rejected the API key (HTTP ${status}) on ${path}. ` +
      `Check ${CAL_API_KEY_ENV} in the server settings - keys are created at ` +
      `https://app.cal.com/settings/developer/api-keys.${upstream ? ` Cal.com said: ${upstream}` : ''}`
    );
  }
  if (status === 404) {
    return (
      `Cal.com returned HTTP 404 for ${path}. Either the item does not exist, or this ` +
      `Cal.com deployment does not serve that route.${upstream ? ` Cal.com said: ${upstream}` : ''}`
    );
  }
  if (status === 429) {
    return `Cal.com rate-limited this request (HTTP 429) on ${path}. Wait a moment and try again.`;
  }
  return `Cal.com returned HTTP ${status} for ${path}.${upstream ? ` Cal.com said: ${upstream}` : ''}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { rawBody: redactSecrets(text.slice(0, 2_000)) };
  }
}

/** Any thrown value becomes a CalComError with an actionable, redacted message. */
function toCalError(error: unknown, baseUrl: string, budget: number): CalComError {
  if (error instanceof CalComError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new CalComError(`${baseUrl} did not respond within ${budget}ms`);
  }
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
  const detail = cause?.code ?? (error instanceof Error ? error.message : String(error));
  return new CalComError(redactSecrets(`${baseUrl} could not be reached: ${detail}`));
}
