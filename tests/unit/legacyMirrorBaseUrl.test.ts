/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: the legacy `model.config` mirror row must carry a usable baseUrl.
 *
 * The registry connect flow stores `creds.baseUrl` ONLY when the user typed a
 * custom URL, so a canonical-host provider (OpenRouter, Groq, ...) mirrored
 * with baseUrl '' - and a Guide chat built from that row sent the provider's
 * key to the OpenAI SDK DEFAULT host (api.openai.com), which 401'd it on the
 * first message (live-caught with an OpenRouter sk-or key). The mirror must
 * fall back to the canonical CHAT_START_BASE_URL, and a user-typed custom URL
 * must still win.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const configStore = new Map<string, unknown>();

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: {
    get: vi.fn(async (key: string) => configStore.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      configStore.set(key, value);
    }),
  },
}));

// eslint-disable-next-line import/first
import { mirrorConnectOrRekey } from '@process/providers/legacyModelConfigBridge';
// eslint-disable-next-line import/first
import { CHAT_START_BASE_URL } from '@process/providers/chatStartHosts';
// eslint-disable-next-line import/first
import type { ProviderRepository } from '@process/providers/storage/ProviderRepository';

type MirrorRepo = Pick<ProviderRepository, 'getRegistryProvider' | 'getRegistryProviderCreds' | 'getRegistryCatalog' | 'listRegistryOverrides'>;

const makeRepo = (creds: Record<string, unknown>): MirrorRepo =>
  ({
    getRegistryProvider: vi.fn(() => ({ providerId: 'openrouter', status: 'connected' })),
    getRegistryProviderCreds: vi.fn(() => ({ status: 'ok', creds })),
    getRegistryCatalog: vi.fn(() => [
      {
        id: 'qwen/qwen3.8-max',
        providerId: 'openrouter',
        displayName: 'Qwen3.8 Max',
        family: 'qwen',
        kind: 'text',
        releaseDate: '2026-08-03',
        enriched: true,
        tags: [],
      },
    ]),
    listRegistryOverrides: vi.fn(() => []),
  }) as unknown as MirrorRepo;

const writtenRow = (): { baseUrl?: string; apiKey?: string } | undefined => {
  const rows = configStore.get('model.config') as Array<{ baseUrl?: string; apiKey?: string }> | undefined;
  return rows?.[rows.length - 1];
};

beforeEach(() => {
  configStore.clear();
});

describe('mirrorConnectOrRekey baseUrl resolution', () => {
  it('falls back to the canonical chat-start host when no custom URL was stored', async () => {
    await mirrorConnectOrRekey(makeRepo({ key: 'sk-or-test' }) as ProviderRepository, 'openrouter');
    const row = writtenRow();
    expect(row).toBeDefined();
    expect(row!.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(row!.baseUrl).toBe(CHAT_START_BASE_URL.openrouter);
  });

  it('a user-typed custom URL still wins over the canonical host', async () => {
    await mirrorConnectOrRekey(
      makeRepo({ key: 'sk-or-test', baseUrl: 'https://proxy.example.mn/v1' }) as ProviderRepository,
      'openrouter'
    );
    expect(writtenRow()!.baseUrl).toBe('https://proxy.example.mn/v1');
  });
});
