/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the resilience filter wired into `usableModels`: a
 * candidate whose provider circuit is open OR whose (provider, model) is 429-
 * locked is filtered out, so the picker falls through to the next provider -
 * cross-provider auto-fallback for free. Only the model bridge and the sibling
 * completion deps are mocked; the resilience state is the real in-memory module.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMergedModelProviders: vi.fn(),
  compress: vi.fn(),
  getCompressionMode: vi.fn(),
  isGoogleAuthGeminiAvailable: vi.fn(),
  googleAuthGeminiComplete: vi.fn(),
}));

vi.mock('@process/bridge/modelBridge', () => ({ getMergedModelProviders: mocks.getMergedModelProviders }));
vi.mock('@process/services/compression', () => ({ compress: mocks.compress }));
vi.mock('@process/services/completion/compressionMode', () => ({ getCompressionMode: mocks.getCompressionMode }));
vi.mock('@process/services/completion/geminiOAuth', () => ({
  isGoogleAuthGeminiAvailable: mocks.isGoogleAuthGeminiAvailable,
  googleAuthGeminiComplete: mocks.googleAuthGeminiComplete,
}));

import { pickCheapestFastModel } from '@process/services/completion/oneShot';
import {
  recordProviderFailure,
  lockModel,
  resetProviderCircuits,
  resetModelLockouts,
  CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_MODEL_LOCKOUT_MS,
} from '@process/services/resilience';
import type { IProvider } from '@/common/config/storage';

const providerA: IProvider = {
  id: 'a',
  platform: 'openai',
  name: 'Provider A',
  baseUrl: 'https://a.test/v1',
  apiKey: 'ka',
  model: ['gpt-4o-mini'],
};
const providerB: IProvider = {
  id: 'b',
  platform: 'openai',
  name: 'Provider B',
  baseUrl: 'https://b.test/v1',
  apiKey: 'kb',
  model: ['gpt-4o-mini'],
};

const openCircuit = (providerId: string): void => {
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) recordProviderFailure(providerId);
};

beforeEach(() => {
  resetProviderCircuits();
  resetModelLockouts();
  mocks.getMergedModelProviders.mockReset();
  mocks.getMergedModelProviders.mockResolvedValue([providerA, providerB]);
});

describe('usableModels resilience filter', () => {
  it('picks the first provider when nothing is tripped', async () => {
    const picked = await pickCheapestFastModel();
    expect(picked?.provider.id).toBe('a');
  });

  it('falls through to the next provider when the first provider circuit is open', async () => {
    openCircuit('a');
    const picked = await pickCheapestFastModel();
    expect(picked?.provider.id).toBe('b'); // A skipped, fell through
  });

  it('falls through when the first provider model is 429-locked', async () => {
    lockModel('a', 'gpt-4o-mini', DEFAULT_MODEL_LOCKOUT_MS);
    const picked = await pickCheapestFastModel();
    expect(picked?.provider.id).toBe('b');
  });

  it('returns null when every candidate is filtered out', async () => {
    openCircuit('a');
    lockModel('b', 'gpt-4o-mini', DEFAULT_MODEL_LOCKOUT_MS);
    const picked = await pickCheapestFastModel();
    expect(picked).toBeNull();
  });
});
