/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Nemotron Монгол v13mn speech-to-text over the Darhai-owned audio.cpp server
 * (docs/architecture/mongolian-voice.md).
 *
 * The renderer's MediaRecorder usually delivers webm/opus; audio.cpp wants
 * WAV, so non-WAV input is converted to 16 kHz mono WAV using the same ffmpeg
 * resolution the video-frame path uses ({@link resolveFfmpegBinary} - PATH
 * only; a missing ffmpeg degrades to a typed error, never a crash). Temp files
 * follow WhisperLocal's stageAudio discipline: tmpdir scratch, removed in a
 * `finally`.
 *
 * The server is started on demand via {@link audioCppServer} and restarted
 * ONCE when a request fails at the connection level (a crash between
 * requests). An HTTP-level error response is NOT retried: the server is alive
 * and answered, so replaying the identical request cannot change the outcome.
 */

import type { SpeechToTextAudioBuffer, SpeechToTextRequest, SpeechToTextResult } from '@/common/types/speech';
import { resolveFfmpegBinary } from '@process/services/video/videoFrames';
import { ProcessConfig } from '@process/utils/initStorage';
import { safeExecFile } from '@process/utils/safeExec';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { audioCppServer, STT_SERVER_MODEL_ID } from './AudioCppServer';
import { glossfix } from './glossfix';
import { applyPersonalDict } from './personalDict';

/** Reported model id: the fine-tune's public name, not the server's config id. */
export const NEMOTRON_MN_MODEL = 'nemotron-mn-v13m';

/** Ceiling for one ffmpeg conversion run (ms); dictation clips are short. */
const CONVERT_TIMEOUT_MS = 60_000;

/** The sample rate the ASR model was trained on. */
const TARGET_SAMPLE_RATE = '16000';

/** MIME subtypes that already are WAV and skip conversion. */
const WAV_MIME_SUBTYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave']);

export type NemotronSttErrorCode =
  'NEMOTRON_MN_FFMPEG_MISSING' | 'NEMOTRON_MN_AUDIO_CONVERT_FAILED' | 'NEMOTRON_MN_REQUEST_FAILED';

/**
 * Typed transcription failure. The message starts with the code so
 * SpeechToTextService's `getErrorCode` (split on ':') surfaces it to the UI.
 */
export class NemotronSttError extends Error {
  readonly code: NemotronSttErrorCode;

  constructor(code: NemotronSttErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'NemotronSttError';
    this.code = code;
  }
}

/** Injectable collaborators - production defaults in {@link defaultNemotronSttDeps}. */
export type NemotronSttDeps = {
  /** POST the multipart transcription request. */
  fetch: (
    url: string,
    init: { method: 'POST'; body: FormData }
  ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  /** Start (or reuse) the audio.cpp server; resolves its base URL. */
  ensureRunning: () => Promise<string>;
  /** Convert non-WAV request audio to 16 kHz mono WAV. */
  convertToWav: (audio: Buffer, mimeType: string) => Promise<Buffer>;
  /** Load the user's personal correction dictionary (wrong → right). */
  loadPersonalDict: () => Promise<Record<string, string>>;
};

/** True when the recording can go to the server without conversion. */
export function isWavMimeType(mimeType: string): boolean {
  const bare = (mimeType || '').split(';')[0].trim().toLowerCase();
  return WAV_MIME_SUBTYPES.has(bare);
}

/** IPC audio payloads arrive as Uint8Array, number[] or index-keyed objects. */
const toBuffer = (audioBuffer: SpeechToTextAudioBuffer): Buffer => {
  if (audioBuffer instanceof Uint8Array) {
    return Buffer.from(audioBuffer);
  }
  if (Array.isArray(audioBuffer)) {
    return Buffer.from(audioBuffer);
  }
  const ordered = Object.keys(audioBuffer)
    .filter((key) => /^\d+$/.test(key))
    .toSorted((a, b) => Number(a) - Number(b))
    .map((key) => audioBuffer[key] ?? 0);
  return Buffer.from(ordered);
};

/**
 * Input-file extension hint for ffmpeg. ffmpeg sniffs the real container from
 * the bytes, so an imprecise hint is harmless - `.bin` still converts.
 */
function extensionForMime(mimeType: string): string {
  const bare = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (bare.includes('webm')) return '.webm';
  if (bare.includes('ogg') || bare.includes('opus')) return '.ogg';
  if (bare.includes('mp4') || bare.includes('m4a')) return '.mp4';
  if (bare.includes('mpeg') || bare.includes('mp3')) return '.mp3';
  return '.bin';
}

/** Human-readable text for an unknown throw. */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Default conversion: stage the recording in a tmpdir, run ffmpeg to 16 kHz
 * mono WAV, read the result, and always remove the scratch directory.
 */
export async function defaultConvertToWav(audio: Buffer, mimeType: string): Promise<Buffer> {
  const ffmpegPath = resolveFfmpegBinary();
  if (ffmpegPath === null) {
    throw new NemotronSttError('NEMOTRON_MN_FFMPEG_MISSING', 'ffmpeg was not found on PATH');
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'darhai-nemotron-'));
  try {
    const inputPath = path.join(dir, `input${extensionForMime(mimeType)}`);
    const outputPath = path.join(dir, 'audio-16k-mono.wav');
    await writeFile(inputPath, audio);
    try {
      await safeExecFile(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          inputPath,
          '-ar',
          TARGET_SAMPLE_RATE,
          '-ac',
          '1',
          '-y',
          outputPath,
        ],
        { timeout: CONVERT_TIMEOUT_MS }
      );
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr || errText(error);
      throw new NemotronSttError('NEMOTRON_MN_AUDIO_CONVERT_FAILED', `ffmpeg failed: ${detail}`);
    }
    return await readFile(outputPath);
  } finally {
    // Best-effort cleanup - never mask the transcription result or error.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One multipart POST to the server; HTTP errors become typed errors here. */
async function requestTranscription(baseUrl: string, wav: Buffer, deps: NemotronSttDeps): Promise<string> {
  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed view: `Buffer` is typed over
  // ArrayBufferLike (it may wrap a SharedArrayBuffer), which BlobPart rejects.
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', STT_SERVER_MODEL_ID);
  const response = await deps.fetch(`${baseUrl}/v1/audio/transcriptions`, { method: 'POST', body: form });
  if (response.ok === false) {
    throw new NemotronSttError('NEMOTRON_MN_REQUEST_FAILED', `audio.cpp answered HTTP ${String(response.status)}`);
  }
  const payload = (await response.json()) as { text?: string };
  return typeof payload.text === 'string' ? payload.text.trim() : '';
}

/**
 * One request, one restart. A connection-level failure (fetch rejects) means
 * the server crashed or is unreachable - {@link NemotronSttDeps.ensureRunning}
 * health-checks and respawns it, and the request is replayed once. A typed
 * error (HTTP-level answer) propagates without a retry.
 */
async function transcribeWithRestart(wav: Buffer, deps: NemotronSttDeps): Promise<string> {
  const baseUrl = await deps.ensureRunning();
  try {
    return await requestTranscription(baseUrl, wav, deps);
  } catch (error) {
    if (error instanceof NemotronSttError) throw error;
    const retryUrl = await deps.ensureRunning();
    try {
      return await requestTranscription(retryUrl, wav, deps);
    } catch (retryError) {
      if (retryError instanceof NemotronSttError) throw retryError;
      throw new NemotronSttError(
        'NEMOTRON_MN_REQUEST_FAILED',
        `audio.cpp unreachable after one restart: ${errText(retryError)}`
      );
    }
  }
}

export const defaultNemotronSttDeps: NemotronSttDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  ensureRunning: () => audioCppServer.ensureRunning(),
  convertToWav: defaultConvertToWav,
  // A broken stored config must degrade to "no corrections", never fail the
  // transcription that already succeeded.
  loadPersonalDict: async () => {
    try {
      const config = await ProcessConfig.get('tools.speechToText');
      const dict = config?.personalDict;
      return dict !== null && typeof dict === 'object' ? dict : {};
    } catch {
      return {};
    }
  },
};

/**
 * Local, offline Mongolian speech-to-text. No API key; the model is
 * Mongolian-only, so `language` is always `'mn'` rather than detected.
 */
// eslint-disable-next-line typescript-eslint/no-extraneous-class -- Static provider class mirrors WhisperLocal's shape
export class NemotronStt {
  static async transcribe(
    request: SpeechToTextRequest,
    deps: NemotronSttDeps = defaultNemotronSttDeps
  ): Promise<SpeechToTextResult> {
    const raw = toBuffer(request.audioBuffer);
    const wav = isWavMimeType(request.mimeType) === true ? raw : await deps.convertToWav(raw, request.mimeType);
    const text = await transcribeWithRestart(wav, deps);
    const personalDict = await deps.loadPersonalDict();
    return {
      language: 'mn',
      model: NEMOTRON_MN_MODEL,
      provider: 'nemotron-mn',
      // The model's one systematic weakness is Cyrillic-spelled foreign terms
      // ("имэйлээр"); the glossary pass restores their Latin form. See
      // glossfix.ts for why its false-positive rate is trusted. The user's
      // personal dictionary runs AFTER it, on its output, so an entry can
      // target the final Latin form of a term glossfix just restored.
      text: applyPersonalDict(glossfix(text), personalDict),
    };
  }
}
