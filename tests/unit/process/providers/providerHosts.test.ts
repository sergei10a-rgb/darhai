/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The connect probe and inference must talk to the SAME host.
 *
 * Two tables name a provider's server: `PROVIDER_ENDPOINTS` (the models
 * endpoint the connect probe validates a key against) and `CHAT_START_BASE_URL`
 * (the base inference is dispatched to). Nothing in the type system ties them
 * together, so they can drift a host apart silently - and the resulting failure
 * is one of the nastiest kinds to report: the key connects GREEN, then the very
 * first message 401s.
 *
 * MiniMax is why this file exists. Its probe was moved to the international
 * `api.minimax.io` host while inference stayed on mainland `api.minimax.chat`,
 * which rejects international keys - so every MiniMax user outside mainland
 * China connected successfully and could not send a single message.
 *
 * A per-provider string assertion would only have pinned MiniMax. This pins the
 * rule, so the next provider to gain a regional split cannot repeat it.
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_ENDPOINTS } from '@process/providers/detection/providerEndpoints';
import { CHAT_START_BASE_URL } from '@process/providers/ipc/modelRegistryIpc';

const hostOf = (url: string): string => new URL(url).host;

describe('provider probe host vs inference host', () => {
  it('agree for every provider that appears in both tables', () => {
    const mismatches: string[] = [];

    for (const [providerId, probeUrl] of Object.entries(PROVIDER_ENDPOINTS)) {
      const inferenceUrl = CHAT_START_BASE_URL[providerId];
      if (!probeUrl || !inferenceUrl) continue;

      const probeHost = hostOf(probeUrl);
      const inferenceHost = hostOf(inferenceUrl);
      if (probeHost !== inferenceHost) {
        mismatches.push(`${providerId}: probe ${probeHost} vs inference ${inferenceHost}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('reaches MiniMax on the international host, not the mainland one', () => {
    // The specific regression: mainland `api.minimax.chat` rejects international
    // keys and vice versa, so this is not interchangeable with `.chat`.
    expect(hostOf(PROVIDER_ENDPOINTS.minimax!)).toBe('api.minimax.io');
    expect(hostOf(CHAT_START_BASE_URL.minimax!)).toBe('api.minimax.io');
  });
});

describe('provider models endpoints', () => {
  it('are all versioned paths', () => {
    // Every one of these APIs versions its routes; an unversioned path is a
    // typo, and it 404s the catalog fetch so a valid key is marked `error`.
    // Perplexity was the lone outlier at a bare `/models`.
    // `v1`, but also `v1beta` (Google) and `v4` - a version segment is `v` plus
    // a digit plus an optional qualifier.
    const unversioned = Object.entries(PROVIDER_ENDPOINTS)
      .filter(([, url]) => url && !/\/v\d+[a-z0-9]*([./]|$)/.test(new URL(url).pathname))
      .map(([providerId, url]) => `${providerId}: ${url}`);

    // Known and intentional: these vendors genuinely serve unversioned paths.
    const allowed = new Set(['huggingface', 'zhipu-glm', 'stability']);
    const unexpected = unversioned.filter((entry) => !allowed.has(entry.split(':')[0]));

    expect(unexpected).toEqual([]);
  });

  it('reaches Perplexity at its versioned models endpoint', () => {
    expect(PROVIDER_ENDPOINTS.perplexity).toBe('https://api.perplexity.ai/v1/models');
  });
});
