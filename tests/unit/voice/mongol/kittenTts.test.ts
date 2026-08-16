/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TTS_CONFIG } from '@/common/types/ttsTypes';
import type { TextToSpeechConfig } from '@/common/types/ttsTypes';
import { KittenTts, KittenTtsRequestError, type KittenTtsRuntime } from '@process/services/voice/mongol/KittenTts';
import {
  KittenTtsUnavailableError,
  type KittenFetchInit,
  type KittenHttpResponse,
  type KittenTtsSession,
} from '@process/services/voice/mongol/KittenTtsServer';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WAV_BYTES = [82, 73, 70, 70]; // 'RIFF'

const session: KittenTtsSession = {
  baseUrl: 'http://127.0.0.1:45123',
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

const wavArrayBuffer = (): ArrayBuffer => {
  const buf = new ArrayBuffer(WAV_BYTES.length);
  new Uint8Array(buf).set(WAV_BYTES);
  return buf;
};

const wavResponse = (): KittenHttpResponse => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => wavArrayBuffer(),
  json: async () => ({}),
});

const httpError = (status: number): KittenHttpResponse => ({
  ok: false,
  status,
  arrayBuffer: async () => new ArrayBuffer(0),
  json: async () => ({}),
});

const jsonResponse = (payload: unknown): KittenHttpResponse => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new ArrayBuffer(0),
  json: async () => payload,
});

const config = (overrides: Partial<TextToSpeechConfig> = {}): TextToSpeechConfig => ({
  ...DEFAULT_TTS_CONFIG,
  enabled: true,
  provider: 'kitten-mn',
  ...overrides,
});

type FetchImpl = (url: string, init?: KittenFetchInit) => Promise<KittenHttpResponse>;

type RuntimeSetup = {
  runtime: KittenTtsRuntime;
  ensureRunning: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
};

const makeRuntime = (fetchImpl?: FetchImpl, running = true): RuntimeSetup => {
  const ensureRunning = vi.fn(async (): Promise<KittenTtsSession> => session);
  const stop = vi.fn(async (): Promise<void> => {});
  const isRunning = vi.fn((): boolean => running);
  const fetchMock = vi.fn(fetchImpl ?? (async (_url: string, _init?: KittenFetchInit) => wavResponse()));
  return {
    runtime: { server: { ensureRunning, stop, isRunning }, fetch: fetchMock },
    ensureRunning,
    stop,
    isRunning,
    fetch: fetchMock,
  };
};

const requestCodeOf = (err: unknown): string => {
  expect(err).toBeInstanceOf(KittenTtsRequestError);
  return (err as KittenTtsRequestError).code;
};

// ---------------------------------------------------------------------------
// synthesize
// ---------------------------------------------------------------------------

describe('KittenTts.synthesize', () => {
  it('posts {text, speed} JSON to speakPath and returns the WAV bytes', async () => {
    const { runtime, fetch } = makeRuntime();
    const audio = await KittenTts.synthesize('Сайн байна уу', config({ voice: 'default', speed: 1.25 }), runtime);

    expect(audio.mimeType).toBe('audio/wav');
    expect(Array.from(audio.data)).toEqual(WAV_BYTES);

    const [url, init] = fetch.mock.calls[0] as [string, KittenFetchInit];
    expect(url).toBe('http://127.0.0.1:45123/api/speak');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    expect(body.text).toBe('Сайн байна уу');
    expect(body.speed).toBe(1.25);
    // voice 'default' means "let the bundle pick": the field must NOT travel.
    expect(Object.keys(body)).toEqual(['text', 'speed']);
  });

  it('includes the voice field when a concrete voice is selected', async () => {
    const { runtime, fetch } = makeRuntime();
    await KittenTts.synthesize('hi', config({ voice: 'mn-female' }), runtime);
    const [, init] = fetch.mock.calls[0] as [string, KittenFetchInit];
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    expect(body.voice).toBe('mn-female');
  });

  it('maps HTTP 413 to KITTEN_MN_TEXT_TOO_LONG', async () => {
    const { runtime } = makeRuntime(async () => httpError(413));
    const err = await KittenTts.synthesize('x'.repeat(10_000), config(), runtime).catch((e: unknown) => e);
    expect(requestCodeOf(err)).toBe('KITTEN_MN_TEXT_TOO_LONG');
  });

  it('maps any other non-2xx status to KITTEN_MN_REQUEST_FAILED', async () => {
    const { runtime } = makeRuntime(async () => httpError(500));
    const err = await KittenTts.synthesize('hi', config(), runtime).catch((e: unknown) => e);
    expect(requestCodeOf(err)).toBe('KITTEN_MN_REQUEST_FAILED');
    expect((err as Error).message).toContain('500');
  });

  it('restarts the server once and retries when the request dies at the socket level', async () => {
    let calls = 0;
    const { runtime, ensureRunning, stop } = makeRuntime(async () => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return wavResponse();
    });

    const audio = await KittenTts.synthesize('hi', config(), runtime);
    expect(Array.from(audio.data)).toEqual(WAV_BYTES);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(ensureRunning).toHaveBeenCalledTimes(2);
  });

  it('retries only once: a second socket failure propagates', async () => {
    const { runtime, ensureRunning } = makeRuntime(async () => {
      throw new Error('socket hang up');
    });
    await expect(KittenTts.synthesize('hi', config(), runtime)).rejects.toThrow('socket hang up');
    expect(ensureRunning).toHaveBeenCalledTimes(2);
  });

  it('propagates a typed availability error without a restart attempt', async () => {
    const notInstalled = new KittenTtsUnavailableError('KITTEN_MN_NOT_INSTALLED', 'bundle missing');
    const { runtime, ensureRunning, stop } = makeRuntime();
    ensureRunning.mockImplementation(async () => {
      throw notInstalled;
    });
    const err = await KittenTts.synthesize('hi', config(), runtime).catch((e: unknown) => e);
    expect(err).toBe(notInstalled);
    expect(stop).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listVoices
// ---------------------------------------------------------------------------

describe('KittenTts.listVoices', () => {
  it('returns the voices array from the status endpoint', async () => {
    const { runtime, fetch } = makeRuntime(async () =>
      jsonResponse({ voices: ['default', 'mn-female'], max_chars: 512 })
    );
    const voices = await KittenTts.listVoices(runtime);
    expect(voices).toEqual(['default', 'mn-female']);
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:45123/api/status');
  });

  it('returns an empty list when the status payload has no usable voices', async () => {
    const { runtime } = makeRuntime(async () => jsonResponse({ max_chars: 512 }));
    expect(await KittenTts.listVoices(runtime)).toEqual([]);
  });

  it('throws KITTEN_MN_REQUEST_FAILED when the status endpoint answers non-2xx', async () => {
    const { runtime } = makeRuntime(async () => httpError(503));
    const err = await KittenTts.listVoices(runtime).catch((e: unknown) => e);
    expect(requestCodeOf(err)).toBe('KITTEN_MN_REQUEST_FAILED');
  });

  it('starts the server by default when it is not running (synthesize behaviour)', async () => {
    const { runtime, ensureRunning } = makeRuntime(async () => jsonResponse({ voices: ['garav'] }), false);
    await expect(KittenTts.listVoices(runtime)).resolves.toEqual(['garav']);
    expect(ensureRunning).toHaveBeenCalledTimes(1);
  });

  it('with startIfNeeded:false returns [] WITHOUT starting a stopped server', async () => {
    const { runtime, ensureRunning, fetch } = makeRuntime(undefined, false);
    await expect(KittenTts.listVoices(runtime, { startIfNeeded: false })).resolves.toEqual([]);
    // The whole point of the option: zero spawn attempts, zero requests.
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('with startIfNeeded:false still queries an ALREADY-RUNNING server', async () => {
    const { runtime, ensureRunning } = makeRuntime(async () => jsonResponse({ voices: ['garav', 'nomin'] }), true);
    await expect(KittenTts.listVoices(runtime, { startIfNeeded: false })).resolves.toEqual(['garav', 'nomin']);
    // ensureRunning on a healthy server is a health-check, not a spawn.
    expect(ensureRunning).toHaveBeenCalledTimes(1);
  });
});
