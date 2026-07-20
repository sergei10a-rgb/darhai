/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the compression seam inside `oneShotComplete`. The model
 * providers, the compression engine, the config accessor, the Google-auth
 * fallback, and `fetch` are all mocked so we assert exactly which prompt reaches
 * the wire under each mode - including the defensive fallbacks - with no network
 * or Electron dependency.
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

import { oneShotComplete } from '@process/services/completion/oneShot';

const PICKED = {
  provider: {
    id: 'anthropic',
    platform: 'anthropic',
    name: 'Anthropic',
    baseUrl: '',
    apiKey: 'sk-ant-x',
    model: ['claude-3-haiku'],
  },
  modelId: 'claude-3-haiku',
};

let sentBody: { messages: Array<{ role: string; content: string }> };

beforeEach(() => {
  mocks.getMergedModelProviders.mockReset();
  mocks.compress.mockReset();
  mocks.getCompressionMode.mockReset();
  mocks.isGoogleAuthGeminiAvailable.mockReset();
  mocks.googleAuthGeminiComplete.mockReset();

  mocks.isGoogleAuthGeminiAvailable.mockReturnValue(false);
  mocks.getCompressionMode.mockResolvedValue('lite');

  global.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ text: 'reply' }] }) } as unknown as Response;
  }) as unknown as typeof fetch;
});

describe('oneShotComplete compression seam', () => {
  it("mode 'off' sends the prompt verbatim and never calls compress", async () => {
    await oneShotComplete('please KEEP this exactly', { model: PICKED, compressionMode: 'off' });

    expect(mocks.compress).not.toHaveBeenCalled();
    expect(mocks.getCompressionMode).not.toHaveBeenCalled(); // per-call override wins
    expect(sentBody.messages[0].content).toBe('please KEEP this exactly');
  });

  it('a non-off mode compresses the prompt before send', async () => {
    mocks.compress.mockReturnValue({
      text: 'KEEP this exactly',
      originalChars: 24,
      compressedChars: 17,
      savedRatio: 0.29,
    });

    await oneShotComplete('please KEEP this exactly', { model: PICKED, compressionMode: 'balanced' });

    expect(mocks.compress).toHaveBeenCalledWith('please KEEP this exactly', 'balanced');
    expect(sentBody.messages[0].content).toBe('KEEP this exactly');
  });

  it('falls back to the original prompt when the compressor throws', async () => {
    mocks.compress.mockImplementation(() => {
      throw new Error('boom');
    });

    await oneShotComplete('original PROMPT text', { model: PICKED, compressionMode: 'aggressive' });

    expect(mocks.compress).toHaveBeenCalled();
    expect(sentBody.messages[0].content).toBe('original PROMPT text');
  });

  it('falls back to the original prompt when compression yields empty output', async () => {
    mocks.compress.mockReturnValue({ text: '   ', originalChars: 7, compressedChars: 3, savedRatio: 0.57 });

    await oneShotComplete('keep me', { model: PICKED, compressionMode: 'lite' });

    expect(sentBody.messages[0].content).toBe('keep me');
  });

  it('uses the configured mode when no per-call override is given', async () => {
    mocks.getCompressionMode.mockResolvedValue('balanced');
    mocks.compress.mockReturnValue({ text: 'shrunk', originalChars: 5, compressedChars: 6, savedRatio: 0 });

    await oneShotComplete('hello', { model: PICKED });

    expect(mocks.getCompressionMode).toHaveBeenCalledTimes(1);
    expect(mocks.compress).toHaveBeenCalledWith('hello', 'balanced');
    expect(sentBody.messages[0].content).toBe('shrunk');
  });
});
