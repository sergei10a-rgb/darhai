/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the routing seam inside `oneShotComplete`. The model
 * providers, the routing-strategy accessor, the pricing authority, the
 * compression engine, and `fetch` are all mocked, so we assert exactly which
 * MODEL is selected under each strategy - with no network or Electron dependency.
 *
 * The load-bearing guarantee: with the strategy unset (default `auto`),
 * selection is byte-identical to `pickCheapestFastModel`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMergedModelProviders: vi.fn(),
  getRoutingStrategy: vi.fn(),
  getCompressionMode: vi.fn(),
  isGoogleAuthGeminiAvailable: vi.fn(),
  googleAuthGeminiComplete: vi.fn(),
  priceTokens: vi.fn(),
}));

vi.mock('@process/bridge/modelBridge', () => ({ getMergedModelProviders: mocks.getMergedModelProviders }));
vi.mock('@process/services/completion/routingStrategy', () => ({ getRoutingStrategy: mocks.getRoutingStrategy }));
vi.mock('@process/services/completion/compressionMode', () => ({ getCompressionMode: mocks.getCompressionMode }));
vi.mock('@process/services/completion/geminiOAuth', () => ({
  isGoogleAuthGeminiAvailable: mocks.isGoogleAuthGeminiAvailable,
  googleAuthGeminiComplete: mocks.googleAuthGeminiComplete,
}));
vi.mock('@process/services/cost/ModelPricing', () => ({
  getModelPricing: () => ({ priceTokens: mocks.priceTokens }),
}));
// Resilience is NOT mocked: the real module reports a healthy circuit / no
// lockout by default, which is exactly the state these fixtures need, and
// `resilientFetch` depends on its other exports (record*/advanceKey).

import { oneShotComplete } from '@process/services/completion/oneShot';
import { usageCounter } from '@process/services/routing';

// Two Anthropic models: the name heuristic prefers `haiku` (fast), but the
// pricing below makes `opus` the cheapest - so the two strategies diverge.
const PROVIDERS = [
  {
    id: 'anthropic',
    platform: 'anthropic',
    name: 'Anthropic',
    baseUrl: '',
    apiKey: 'sk-ant-x',
    model: ['claude-3-haiku', 'claude-3-opus'],
  },
];

const RATES: Record<string, { input: number; output: number }> = {
  'claude-3-haiku': { input: 100, output: 100 },
  'claude-3-opus': { input: 1, output: 1 },
};

let sentBody: { model: string };

beforeEach(() => {
  usageCounter.reset();
  for (const m of Object.values(mocks)) m.mockReset();

  mocks.getMergedModelProviders.mockResolvedValue(PROVIDERS);
  mocks.getCompressionMode.mockResolvedValue('off');
  mocks.isGoogleAuthGeminiAvailable.mockReturnValue(false);
  mocks.priceTokens.mockImplementation((modelId: string, t: { input: number; output: number }) => {
    const rate = RATES[modelId];
    if (!rate) return undefined;
    return (t.input / 1_000_000) * rate.input + (t.output / 1_000_000) * rate.output;
  });

  global.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ text: 'reply' }] }) } as unknown as Response;
  }) as unknown as typeof fetch;
});

describe('oneShotComplete routing seam', () => {
  it("default 'auto' selects exactly what pickCheapestFastModel selects (the fast heuristic)", async () => {
    mocks.getRoutingStrategy.mockResolvedValue('auto');

    await oneShotComplete('hello');

    // haiku outranks opus in the name heuristic, so auto must pick it - unchanged.
    expect(sentBody.model).toBe('claude-3-haiku');
    // auto never consults the pricing authority.
    expect(mocks.priceTokens).not.toHaveBeenCalled();
  });

  it("'cost-optimized' selects the cheapest usable model (diverging from the heuristic)", async () => {
    mocks.getRoutingStrategy.mockResolvedValue('cost-optimized');

    await oneShotComplete('hello');

    expect(sentBody.model).toBe('claude-3-opus');
    expect(mocks.priceTokens).toHaveBeenCalled();
  });

  it('records the selected model so least-used / round-robin have live history', async () => {
    mocks.getRoutingStrategy.mockResolvedValue('cost-optimized');

    await oneShotComplete('hello');

    expect(usageCounter.getCount('anthropic', 'claude-3-opus')).toBe(1);
    expect(usageCounter.getCount('anthropic', 'claude-3-haiku')).toBe(0);
  });

  it('an explicit opts.model bypasses routing entirely', async () => {
    mocks.getRoutingStrategy.mockResolvedValue('cost-optimized');

    await oneShotComplete('hello', {
      model: { provider: PROVIDERS[0], modelId: 'claude-3-haiku' },
    });

    expect(sentBody.model).toBe('claude-3-haiku');
    expect(mocks.getRoutingStrategy).not.toHaveBeenCalled();
  });
});
