/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * NemotronStt transcription tests. The server lifecycle, the HTTP boundary and
 * the ffmpeg conversion are all injected fakes; the multipart body is a real
 * FormData so the asserts read the exact fields audio.cpp would receive.
 */

import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

// NemotronStt transitively imports videoFrames (for the ffmpeg resolution),
// whose initStorage import runs real storage/i18n side effects at import time.
// Same mock the videoFrames tests use.
vi.mock('@process/utils/initStorage', () => ({
  getSystemDir: () => ({ cacheDir: tmpdir() }),
  // Referenced by defaultNemotronSttDeps.loadPersonalDict; the tests below
  // always inject their own dict, so this is import-time plumbing only.
  ProcessConfig: { get: async (): Promise<undefined> => undefined },
}));

import {
  NEMOTRON_MN_MODEL,
  NemotronStt,
  NemotronSttError,
  isWavMimeType,
} from '@process/services/voice/mongol/NemotronStt';
import type { NemotronSttDeps } from '@process/services/voice/mongol/NemotronStt';
import { STT_SERVER_MODEL_ID } from '@process/services/voice/mongol/AudioCppServer';

const BASE_URL = 'http://127.0.0.1:9911';

type TranscriptionResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

const okResponse = (text: string): TranscriptionResponse => ({
  ok: true,
  status: 200,
  json: async () => ({ text }),
});

type Harness = {
  deps: NemotronSttDeps;
  fetch: ReturnType<typeof vi.fn>;
  ensureRunning: ReturnType<typeof vi.fn>;
  convertToWav: ReturnType<typeof vi.fn>;
  loadPersonalDict: ReturnType<typeof vi.fn>;
};

const makeHarness = (
  fetchImpl?: () => Promise<TranscriptionResponse>,
  personalDict: Record<string, string> = {}
): Harness => {
  const fetch = vi.fn(fetchImpl ?? (async () => okResponse(' сайн байна уу ')));
  const ensureRunning = vi.fn(async () => BASE_URL);
  const convertToWav = vi.fn(async () => Buffer.from('converted-wav'));
  const loadPersonalDict = vi.fn(async () => personalDict);
  return {
    deps: { fetch, ensureRunning, convertToWav, loadPersonalDict } as unknown as NemotronSttDeps,
    fetch,
    ensureRunning,
    convertToWav,
    loadPersonalDict,
  };
};

const wavRequest = (audioBuffer: Uint8Array | Record<string, number>) => ({
  audioBuffer,
  fileName: 'take.wav',
  mimeType: 'audio/wav',
});

describe('NemotronStt', () => {
  it('sends WAV audio straight through as multipart with the server model id', async () => {
    const h = makeHarness();
    const wavBytes = Uint8Array.from([82, 73, 70, 70, 1, 2, 3]); // "RIFF" + payload
    const result = await NemotronStt.transcribe(wavRequest(wavBytes), h.deps);

    expect(h.convertToWav).not.toHaveBeenCalled();
    expect(h.ensureRunning).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = h.fetch.mock.calls[0] as [string, { method: string; body: FormData }];
    expect(url).toBe(`${BASE_URL}/v1/audio/transcriptions`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('model')).toBe(STT_SERVER_MODEL_ID);
    const file = init.body.get('file');
    expect(file).toBeInstanceOf(Blob);
    const sent = new Uint8Array(await (file as Blob).arrayBuffer());
    expect(Array.from(sent)).toEqual(Array.from(wavBytes));

    expect(result).toEqual({
      language: 'mn',
      model: NEMOTRON_MN_MODEL,
      provider: 'nemotron-mn',
      text: 'сайн байна уу',
    });
  });

  it('treats audio/x-wav as WAV and skips conversion', async () => {
    const h = makeHarness();
    await NemotronStt.transcribe(
      { audioBuffer: Uint8Array.from([1, 2]), fileName: 'take.wav', mimeType: 'audio/x-wav' },
      h.deps
    );
    expect(h.convertToWav).not.toHaveBeenCalled();
  });

  it('accepts index-keyed IPC audio payloads', async () => {
    const h = makeHarness();
    await NemotronStt.transcribe(wavRequest({ 0: 7, 1: 9 }), h.deps);
    const [, init] = h.fetch.mock.calls[0] as [string, { body: FormData }];
    const sent = new Uint8Array(await (init.body.get('file') as Blob).arrayBuffer());
    expect(Array.from(sent)).toEqual([7, 9]);
  });

  it('converts non-WAV recordings to 16 kHz WAV before upload', async () => {
    const h = makeHarness();
    const webm = Uint8Array.from([26, 69, 223, 163]);
    await NemotronStt.transcribe(
      { audioBuffer: webm, fileName: 'take.webm', mimeType: 'audio/webm;codecs=opus' },
      h.deps
    );

    expect(h.convertToWav).toHaveBeenCalledTimes(1);
    const [audioArg, mimeArg] = h.convertToWav.mock.calls[0] as [Buffer, string];
    expect(Array.from(audioArg)).toEqual(Array.from(webm));
    expect(mimeArg).toBe('audio/webm;codecs=opus');

    const [, init] = h.fetch.mock.calls[0] as [string, { body: FormData }];
    const sent = new Uint8Array(await (init.body.get('file') as Blob).arrayBuffer());
    expect(Buffer.from(sent).toString()).toBe('converted-wav');
  });

  it('restarts the server once when the request fails at the connection level', async () => {
    let call = 0;
    const h = makeHarness(async () => {
      call += 1;
      if (call === 1) throw new TypeError('fetch failed');
      return okResponse('дахин ажиллалаа');
    });

    const result = await NemotronStt.transcribe(wavRequest(Uint8Array.from([1])), h.deps);
    expect(result.text).toBe('дахин ажиллалаа');
    expect(h.ensureRunning).toHaveBeenCalledTimes(2);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws a typed error when the server stays unreachable after one restart', async () => {
    const h = makeHarness(async () => {
      throw new TypeError('fetch failed');
    });

    const failure = await NemotronStt.transcribe(wavRequest(Uint8Array.from([1])), h.deps).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NemotronSttError);
    expect((failure as NemotronSttError).code).toBe('NEMOTRON_MN_REQUEST_FAILED');
    expect((failure as Error).message).toMatch(/^NEMOTRON_MN_REQUEST_FAILED:/);
    expect(h.ensureRunning).toHaveBeenCalledTimes(2);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry an HTTP-level error response', async () => {
    const h = makeHarness(async () => ({ ok: false, status: 500, json: async () => ({}) }));

    const failure = await NemotronStt.transcribe(wavRequest(Uint8Array.from([1])), h.deps).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NemotronSttError);
    expect((failure as NemotronSttError).code).toBe('NEMOTRON_MN_REQUEST_FAILED');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.ensureRunning).toHaveBeenCalledTimes(1);
  });

  it('applies the personal dictionary to the transcript (whole word only)', async () => {
    const h = makeHarness(async () => okResponse('коён цаг коёнхон'), { коён: 'хоёр' });
    const result = await NemotronStt.transcribe(wavRequest(Uint8Array.from([1])), h.deps);
    expect(h.loadPersonalDict).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('хоёр цаг коёнхон');
  });

  it('runs glossfix FIRST and the personal dictionary on its output', async () => {
    // The dict entry targets the Latin form glossfix produces («имэйл» →
    // «email»), so it can only fire if the order is glossfix → dict. Reversed,
    // the dict would see «имэйл», match nothing, and the assert fails.
    const h = makeHarness(async () => okResponse('имэйл илгээ'), { email: 'цахим шуудан' });
    const result = await NemotronStt.transcribe(wavRequest(Uint8Array.from([1])), h.deps);
    expect(result.text).toBe('цахим шуудан илгээ');
  });

  it('classifies WAV mime types with and without codec parameters', () => {
    expect(isWavMimeType('audio/wav')).toBe(true);
    expect(isWavMimeType('audio/x-wav')).toBe(true);
    expect(isWavMimeType('audio/wav;codecs=1')).toBe(true);
    expect(isWavMimeType('audio/webm;codecs=opus')).toBe(false);
    expect(isWavMimeType('audio/ogg')).toBe(false);
    expect(isWavMimeType('')).toBe(false);
  });
});
