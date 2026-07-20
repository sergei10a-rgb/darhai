/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resilient wrapper the `oneShotComplete` send sites call instead of a raw
 * `fetch`. It parses a provider's (possibly multi-) API key, tries a key, and on
 * a retryable failure rotates to the next available key with bounded retries and
 * backoff - then feeds the per-provider circuit breaker and per-model 429 lockout
 * so future model selection routes around a struggling provider.
 *
 * Key rotation and per-key cooldown are NOT reimplemented here: they are reused
 * wholesale from `ApiKeyManager` (comma/newline `parseKeys`, 90s blacklist,
 * next-available rotation). This file only adds the text-path wiring plus the two
 * missing layers (breaker + model lockout).
 *
 * Happy path is unchanged: with a single valid key the first attempt succeeds and
 * returns immediately, with no extra latency and no backoff.
 */

import { AuthType } from '@office-ai/aioncli-core';
import { ApiKeyManager } from '@/common/api/ApiKeyManager';
import type { ApiError } from '@/common/api/RotatingApiClient';
import type { IProvider } from '@/common/config/storage';
import {
  recordProviderFailure,
  recordProviderSuccess,
  lockModel,
  DEFAULT_MODEL_LOCKOUT_MS,
} from '@process/services/resilience';

/** Endpoint dialect, used to pick the auth type for key rotation. */
export type ResilientFlavor = 'anthropic' | 'gemini' | 'openai';

/** A fully-built request for one specific API key. */
export type BuiltRequest = { url: string; init: RequestInit };

export type ResilientFetchParams = {
  provider: IProvider;
  modelId: string;
  flavor: ResilientFlavor;
  /** Builds the wire request for a given key (header vs. query placement differs per flavor). */
  buildRequest: (apiKey: string) => BuiltRequest;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

const authTypeForFlavor = (flavor: ResilientFlavor): AuthType => {
  switch (flavor) {
    case 'anthropic':
      return AuthType.USE_ANTHROPIC;
    case 'gemini':
      return AuthType.USE_GEMINI;
    case 'openai':
      return AuthType.USE_OPENAI;
  }
};

/**
 * Mirrors `RotatingApiClient.isRetryableError`: retry on 401 (rotate a bad key),
 * 429 (rate limit), 503, and any 5xx.
 */
const isRetryableStatus = (status: number): boolean =>
  status === 401 || status === 429 || status === 503 || (status >= 500 && status < 600);

/** A retryable server-availability failure (feeds the circuit breaker). */
const isServerFailureStatus = (status: number): boolean => status >= 500 && status < 600;

const makeStatusError = (status: number): ApiError => {
  const err = new Error(`${status}: request failed`) as ApiError;
  err.status = status;
  return err;
};

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Advance to the next usable key for the next attempt. With multiple keys this
 * blacklists the failed key (90s) and rotates via `ApiKeyManager`, returning
 * false once every key is blacklisted. With a single key there is nothing to
 * rotate, so a same-key retry is allowed (helps a transient 5xx / network blip).
 */
const advanceKey = (keyManager: ApiKeyManager): boolean => {
  if (keyManager.hasMultipleKeys()) return keyManager.rotateKey();
  return true;
};

export async function resilientFetch(params: ResilientFetchParams): Promise<Response> {
  const { provider, modelId, flavor, buildRequest } = params;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = params.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = params.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  // Reuse ApiKeyManager for the key set (parseKeys) + per-key cooldown state.
  const keyManager = new ApiKeyManager(provider.apiKey, authTypeForFlavor(flavor));

  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const apiKey = keyManager.getCurrentKey();
    const { url, init } = buildRequest(apiKey);
    const isLastAttempt = attempt === maxRetries - 1;

    try {
      const res = await fetchWithTimeout(url, init, timeoutMs);

      if (res.ok) {
        recordProviderSuccess(provider.id);
        return res;
      }

      const status = res.status;
      if (status === 429) lockModel(provider.id, modelId, DEFAULT_MODEL_LOCKOUT_MS);
      if (isServerFailureStatus(status)) recordProviderFailure(provider.id);

      if (!isRetryableStatus(status)) {
        // The provider answered with a client error (400 / 404 / ...): it is
        // reachable, so let the caller parse the body and throw exactly as
        // before. Byte-identical to the pre-resilience error path.
        recordProviderSuccess(provider.id);
        return res;
      }

      lastError = makeStatusError(status);
      if (!isLastAttempt && advanceKey(keyManager)) {
        if (retryDelayMs > 0) await delay(retryDelayMs * (attempt + 1));
        continue;
      }
      break;
    } catch (err) {
      // Network error / timeout / abort: a provider-availability failure.
      recordProviderFailure(provider.id);
      lastError = err;
      if (!isLastAttempt && advanceKey(keyManager)) {
        if (retryDelayMs > 0) await delay(retryDelayMs * (attempt + 1));
        continue;
      }
      break;
    }
  }

  throw lastError ?? new Error('resilient-fetch: all attempts exhausted');
}
