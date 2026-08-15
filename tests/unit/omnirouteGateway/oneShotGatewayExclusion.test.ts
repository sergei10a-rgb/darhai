/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE critical Phase 7b test (owner condition 3): the OmniRoute gateway is
 * EXPLICIT-selection-only. Every automatic pick flows through `usableModels`
 * (pickCheapestFastModel / pickBestModel / all routing strategies), so the
 * gateway mirror row must never be selected there - even when its model would
 * win the ranking - while an explicit `opts.model` pin still reaches it.
 *
 * The gateway fixture deliberately carries the BEST-ranked fast model
 * (`haiku`, fastRank 0) and a valid key, so any regression in the guard makes
 * these assertions fail loudly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IProvider } from '@/common/config/storage';
import { OMNIROUTE_GATEWAY_DISPLAY_NAME } from '@/common/types/omnirouteGateway';

const mocks = vi.hoisted(() => ({
  getMergedModelProviders: vi.fn(),
  getRoutingStrategy: vi.fn(),
  getCompressionMode: vi.fn(),
  isGoogleAuthGeminiAvailable: vi.fn(),
  googleAuthGeminiComplete: vi.fn(),
}));

vi.mock('@process/bridge/model/modelBridge', () => ({ getMergedModelProviders: mocks.getMergedModelProviders }));
vi.mock('@process/services/completion/routingStrategy', () => ({ getRoutingStrategy: mocks.getRoutingStrategy }));
vi.mock('@process/services/completion/compressionMode', () => ({ getCompressionMode: mocks.getCompressionMode }));
vi.mock('@process/services/completion/geminiOAuth', () => ({
  isGoogleAuthGeminiAvailable: mocks.isGoogleAuthGeminiAvailable,
  googleAuthGeminiComplete: mocks.googleAuthGeminiComplete,
}));

import { oneShotComplete, pickBestModel, pickCheapestFastModel } from '@process/services/completion/oneShot';
import { BRIDGE_TAG_KEY } from '@process/providers/legacyModelConfigBridge';
import { usageCounter } from '@process/services/routing';

/** The real provider the auto-picks are allowed to use (worst fast-rank). */
const REAL_PROVIDER: IProvider = {
  id: 'real-anthropic',
  platform: 'anthropic',
  name: 'Anthropic',
  baseUrl: '',
  apiKey: 'sk-ant-x',
  model: ['claude-3-opus'],
};

/**
 * The OmniRoute gateway's legacy mirror row, exactly as
 * `mirrorConnectOrRekey` writes it: openai-compatible platform, relay-marked
 * name, and the per-provider bridge tag the auto-pick guard keys on. It
 * carries the BEST fast-ranked model + a key, so without the guard every
 * auto-pick would choose it.
 */
const GATEWAY_ROW = {
  id: 'mirror-uuid-1',
  platform: 'openai-compatible',
  name: OMNIROUTE_GATEWAY_DISPLAY_NAME,
  baseUrl: 'http://localhost:20128/v1',
  apiKey: 'or-key',
  model: ['claude-3-haiku'],
  [BRIDGE_TAG_KEY]: 'v2:omniroute-gateway',
} as unknown as IProvider;

let sentUrl: string;
let sentBody: { model: string };

beforeEach(() => {
  usageCounter.reset();
  for (const m of Object.values(mocks)) m.mockReset();

  mocks.getMergedModelProviders.mockResolvedValue([REAL_PROVIDER, GATEWAY_ROW]);
  mocks.getRoutingStrategy.mockResolvedValue('auto');
  mocks.getCompressionMode.mockResolvedValue('off');
  mocks.isGoogleAuthGeminiAvailable.mockReturnValue(false);

  global.fetch = vi.fn(async (url: unknown, init: { body: string }) => {
    sentUrl = String(url);
    sentBody = JSON.parse(init.body);
    // `text` as well as `json` - see the note in oneShotCompression.test.ts.
    const body = {
      content: [{ text: 'reply' }],
      choices: [{ message: { content: 'reply' } }],
    };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
});

describe('usableModels excludes the OmniRoute gateway (owner condition 3)', () => {
  it('pickCheapestFastModel skips the gateway even though its model outranks everything', async () => {
    const picked = await pickCheapestFastModel();
    expect(picked).not.toBeNull();
    expect(picked?.provider.id).toBe('real-anthropic');
    expect(picked?.modelId).toBe('claude-3-opus');
  });

  it('pickBestModel never selects the gateway either', async () => {
    const picked = await pickBestModel();
    expect(picked?.provider.id).toBe('real-anthropic');
  });

  it('the auto strategy in oneShotComplete never routes through the relay', async () => {
    await oneShotComplete('hello');
    expect(sentBody.model).toBe('claude-3-opus');
    expect(sentUrl).not.toContain('localhost:20128');
  });

  it('non-auto routing strategies (round-robin) never rotate onto the gateway', async () => {
    mocks.getRoutingStrategy.mockResolvedValue('round-robin');
    // Sequential on purpose: round-robin rotation + the shared sentUrl/sentBody
    // capture require one completed call before the next starts.
    for (let i = 0; i < 4; i++) {
      // eslint-disable-next-line no-await-in-loop
      await oneShotComplete('hello');
      expect(sentUrl).not.toContain('localhost:20128');
      expect(sentBody.model).toBe('claude-3-opus');
    }
  });

  it('with ONLY the gateway available, auto-picks find nothing (no silent relay fallback)', async () => {
    mocks.getMergedModelProviders.mockResolvedValue([GATEWAY_ROW]);
    expect(await pickCheapestFastModel()).toBeNull();
    await expect(oneShotComplete('hello')).rejects.toThrow('no-usable-model');
  });

  it('an EXPLICIT opts.model pin on the gateway still works (the user chose it)', async () => {
    await oneShotComplete('hello', { model: { provider: GATEWAY_ROW, modelId: 'claude-3-haiku' } });
    expect(sentUrl).toContain('localhost:20128');
    expect(sentBody.model).toBe('claude-3-haiku');
  });

  it('a legacy bare-v2 tagged openai-compatible row is NOT excluded (guard precision)', async () => {
    const legacyRow = {
      ...GATEWAY_ROW,
      id: 'legacy-groq',
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: ['llama-8b'],
      [BRIDGE_TAG_KEY]: 'v2',
    } as unknown as IProvider;
    mocks.getMergedModelProviders.mockResolvedValue([legacyRow]);

    const picked = await pickCheapestFastModel();
    expect(picked?.provider.id).toBe('legacy-groq');
  });
});
