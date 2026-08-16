/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_TTS_CONFIG, normalizeTextToSpeechConfig } from '@/common/types/ttsTypes';
import type { TextToSpeechConfig } from '@/common/types/ttsTypes';
import { KokoroLocal, KokoroLocalUnavailableError, type KokoroLocalRuntime } from '@process/services/voice/KokoroLocal';
import {
  KokoroRemovedError,
  SystemNativeUnsupportedError,
  synthesize,
} from '@process/services/voice/TextToSpeechService';
import type { KittenTtsRuntime } from '@process/services/voice/mongol/KittenTts';
import type { KittenHttpResponse, KittenTtsSession } from '@process/services/voice/mongol/KittenTtsServer';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig = (overrides: Partial<TextToSpeechConfig> = {}): TextToSpeechConfig => ({
  ...DEFAULT_TTS_CONFIG,
  enabled: true,
  provider: 'kokoro-local',
  ...overrides,
});

const fakeKokoroRuntime = (overrides: Partial<KokoroLocalRuntime> = {}): KokoroLocalRuntime => ({
  resolveBinary: () => '/fake/bin/kokoro-cli',
  resolveModel: (voice) => `/fake/kokoro-models/${voice}.onnx`,
  run: vi.fn(async () => new Uint8Array([82, 73, 70, 70])), // fake WAV header bytes
  ...overrides,
});

const fakeKittenSession: KittenTtsSession = {
  baseUrl: 'http://127.0.0.1:5555',
  manifest: {
    name: 'kitten-mn-tts',
    version: 1,
    api: 'kitten-v1',
    entry: 'python/python.exe',
    args: ['service/server.py', '--onnx', '--port', '{port}'],
    healthPath: '/api/status',
    speakPath: '/api/speak',
  },
};

const fakeKittenWav = (): ArrayBuffer => {
  const buf = new ArrayBuffer(4);
  new Uint8Array(buf).set([82, 73, 70, 70]); // 'RIFF'
  return buf;
};

const fakeKittenRuntime = (): KittenTtsRuntime => ({
  server: { ensureRunning: async () => fakeKittenSession, stop: async () => {}, isRunning: () => true },
  fetch: async (): Promise<KittenHttpResponse> => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => fakeKittenWav(),
    json: async () => ({}),
  }),
});

// ---------------------------------------------------------------------------
// normalizeTextToSpeechConfig
// ---------------------------------------------------------------------------

describe('normalizeTextToSpeechConfig', () => {
  it('returns full defaults when called with no arguments', () => {
    const config = normalizeTextToSpeechConfig();
    expect(config).toEqual(DEFAULT_TTS_CONFIG);
  });

  it('fills missing fields with defaults', () => {
    const config = normalizeTextToSpeechConfig({ enabled: true });
    expect(config.enabled).toBe(true);
    expect(config.provider).toBe(DEFAULT_TTS_CONFIG.provider);
    expect(config.voice).toBe(DEFAULT_TTS_CONFIG.voice);
    expect(config.speed).toBe(DEFAULT_TTS_CONFIG.speed);
    expect(config.autoReadResponses).toBe(DEFAULT_TTS_CONFIG.autoReadResponses);
  });

  it('preserves supplied values over defaults', () => {
    const config = normalizeTextToSpeechConfig({ provider: 'system-native', speed: 1.5, voice: 'en-us' });
    expect(config.provider).toBe('system-native');
    expect(config.speed).toBe(1.5);
    expect(config.voice).toBe('en-us');
  });
});

// ---------------------------------------------------------------------------
// KokoroLocal.synthesize
// ---------------------------------------------------------------------------

describe('KokoroLocal.synthesize', () => {
  it('returns non-empty audio for a fixture string via the mock runtime', async () => {
    const runtime = fakeKokoroRuntime();
    const result = await KokoroLocal.synthesize('Hello world', baseConfig(), runtime);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.mimeType).toBe('audio/wav');
  });

  it('passes model path, voice, speed, and text to the binary', async () => {
    const run = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const runtime = fakeKokoroRuntime({ run });
    await KokoroLocal.synthesize('Test', baseConfig({ voice: 'en-us', speed: 1.25 }), runtime);
    const [binary, args] = run.mock.calls[0] as [string, string[]];
    expect(binary).toBe('/fake/bin/kokoro-cli');
    expect(args).toContain('/fake/kokoro-models/en-us.onnx');
    expect(args).toContain('en-us');
    expect(args).toContain('1.25');
    expect(args).toContain('Test');
  });

  it('throws KokoroLocalUnavailableError when the binary is missing', async () => {
    const runtime = fakeKokoroRuntime({ resolveBinary: () => null });
    await expect(KokoroLocal.synthesize('hi', baseConfig(), runtime)).rejects.toBeInstanceOf(
      KokoroLocalUnavailableError
    );
  });

  it('throws KokoroLocalUnavailableError when the model is missing', async () => {
    const runtime = fakeKokoroRuntime({ resolveModel: () => null });
    await expect(KokoroLocal.synthesize('hi', baseConfig(), runtime)).rejects.toBeInstanceOf(
      KokoroLocalUnavailableError
    );
  });

  it('uses a coded error message the TTS service can surface to the user', async () => {
    const runtime = fakeKokoroRuntime({ resolveBinary: () => null });
    await expect(KokoroLocal.synthesize('hi', baseConfig(), runtime)).rejects.toThrow(/^TTS_KOKORO_LOCAL_UNAVAILABLE/);
  });

  it('does not invoke run when the binary is missing', async () => {
    const run = vi.fn(async () => new Uint8Array(0));
    const runtime = fakeKokoroRuntime({ resolveBinary: () => null, run });
    await expect(KokoroLocal.synthesize('hi', baseConfig(), runtime)).rejects.toBeInstanceOf(
      KokoroLocalUnavailableError
    );
    expect(run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TextToSpeechService.synthesize - provider routing
// ---------------------------------------------------------------------------

describe('synthesize (TextToSpeechService)', () => {
  it('routes kitten-mn to KittenTts and returns WAV audio', async () => {
    const result = await synthesize('Сайн уу', baseConfig({ provider: 'kitten-mn' }), fakeKittenRuntime());
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.mimeType).toBe('audio/wav');
  });

  it('throws the typed TTS_KOKORO_REMOVED error for kokoro-local instead of invoking KokoroLocal', async () => {
    const err = await synthesize('Hello', baseConfig({ provider: 'kokoro-local' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KokoroRemovedError);
    expect((err as KokoroRemovedError).code).toBe('TTS_KOKORO_REMOVED');
    expect((err as Error).message).toMatch(/^TTS_KOKORO_REMOVED/);
    // The message must explain WHY (404 binaries, non-existent CLI) so the
    // user is not left guessing - see docs/architecture/mongolian-voice.md.
    expect((err as Error).message).toContain('404');
  });

  it('refuses system-native on non-macOS with a typed error instead of silent empty audio', async () => {
    // The old contract returned zero bytes of "audio" here, which made a
    // misconfigured Windows install look healthy - the exact failure mode
    // that kept the inherited voice layer broken unnoticed (adversarial
    // review finding Б-6). The typed error is the stronger contract.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const err = await synthesize('Hello', baseConfig({ provider: 'system-native' })).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(SystemNativeUnsupportedError);
      expect((err as SystemNativeUnsupportedError).code).toBe('TTS_SYSTEM_NATIVE_UNSUPPORTED');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});
