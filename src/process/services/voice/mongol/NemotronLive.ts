/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live (streaming) Mongolian dictation over the audio.cpp server's
 * `POST /v1/audio/transcriptions/live` SSE route (docs/architecture/
 * mongolian-voice.md). The server already loads the Nemotron model with
 * `mode: 'streaming'` (AudioCppServer.writeServerConfig), so partial text
 * flows while the user is still speaking - measured in mn-asr-app: first
 * delta ~2.2 s into speech, final text 471 ms after speech ends, streaming
 * CER 16.33% vs 15.32% offline.
 *
 * Ported from the measured reference implementation (mn-asr-app
 * `core/audiocpp_engine.py::_LiveHandle` and mn-asr `audiocpp/10_test_live.py`),
 * whose hard-won rules are load-bearing here:
 *
 *   - The request body MUST be chunked: the server answers HTTP 400 to a
 *     Content-Length body on this route, and hand-rolled `%x\r\n` framing
 *     stalled. Node's ClientRequest emits `Transfer-Encoding: chunked`
 *     exactly when no Content-Length is set - which is why this lives in the
 *     MAIN process (renderer fetch cannot stream a request body here).
 *   - The model id travels in the QUERY STRING (`?model=mn-asr`), the body is
 *     raw PCM 16 kHz mono s16le, `Content-Type: audio/pcm`.
 *   - The `done` event REPEATS the full text. It must REPLACE the accumulated
 *     partial, never be appended to it, or the final text doubles.
 *   - Errors can arrive INSIDE the SSE stream while HTTP stays 200.
 *   - If the live path breaks mid-session (socket error, non-200, SSE error),
 *     the buffered PCM falls back to the batch NemotronStt path so dictation
 *     still produces a final text (the `_LiveHandle` fallback principle).
 *
 * One session at a time: a new start() cancels the previous session. The
 * active session is also cancelled when {@link stopAudioCppServer} runs (app
 * quit path) via {@link registerAudioCppServerStopListener}.
 */

import { request as httpRequest } from 'node:http';
import { audioCppServer, registerAudioCppServerStopListener, STT_SERVER_MODEL_ID } from './AudioCppServer';
import { glossfix } from './glossfix';

/** The sample rate / channel shape of the PCM this session accepts. */
const PCM_SAMPLE_RATE = 16_000;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_CHANNELS = 1;

/**
 * Fallback-buffer ceiling (~35 min of 16 kHz s16le mono). Beyond this the
 * session keeps streaming to the live route but stops growing the in-memory
 * batch-fallback copy, so an absurdly long dictation cannot exhaust main
 * process memory.
 */
const MAX_FALLBACK_BYTES = 64 * 1024 * 1024;

/**
 * How long stop() waits for the server's final `done` after ending the body.
 * Measured final latency is 471 ms; 30 s is generous headroom, and on expiry
 * the accumulated partial is used instead (the reference behaviour).
 */
const STOP_TIMEOUT_MS = 30_000;

export type NemotronLiveErrorCode = 'NEMOTRON_MN_LIVE_FAILED' | 'NEMOTRON_MN_LIVE_NOT_ACTIVE';

/**
 * Typed live-dictation failure. The message starts with the code so
 * SpeechToTextService-style `getErrorCode` (split on ':') surfaces it to the
 * renderer over the bridge error path.
 */
export class NemotronLiveError extends Error {
  readonly code: NemotronLiveErrorCode;

  constructor(code: NemotronLiveErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'NemotronLiveError';
    this.code = code;
  }
}

/** Callbacks a live connection reports through (SSE read side). */
export type LiveSseHandlers = {
  /** HTTP status line arrived; anything but 200 marks the live path broken. */
  status: (statusCode: number) => void;
  /** A chunk of the SSE response body (utf-8 text, possibly mid-line). */
  data: (chunk: string) => void;
  /** The SSE stream ended (server closed after `done`). */
  end: () => void;
  /** Transport-level failure (refused, reset, hang up). */
  error: (err: Error) => void;
};

/** The write side of one live connection. */
export type LiveConnection = {
  /** Stream one raw PCM chunk into the (chunked) request body. */
  write: (chunk: Uint8Array) => void;
  /** Finish the request body - tells the server the audio is complete. */
  end: () => void;
  /** Abort the request/response immediately. */
  destroy: () => void;
};

/** Injectable collaborators - production defaults in {@link defaultNemotronLiveDeps}. */
export type NemotronLiveDeps = {
  /** Start (or reuse) the audio.cpp server; resolves its base URL. */
  ensureRunning: () => Promise<string>;
  /** Open the live SSE request against the server. */
  connect: (baseUrl: string, handlers: LiveSseHandlers) => LiveConnection;
  /**
   * Batch fallback: transcribe a complete WAV (the buffered PCM re-wrapped)
   * when the live path broke. Returns the FINAL text (already glossfixed by
   * the batch path).
   */
  batchTranscribe: (wav: Buffer) => Promise<string>;
  /** How long stop() waits for the final `done` after ending the body. */
  stopTimeoutMs: number;
};

/** Renderer-facing session events. */
export type NemotronLiveEvents = {
  /**
   * Fired with the FULL accumulated partial text on every delta. The consumer
   * REPLACES its display with this string - deltas are merged here, in main,
   * exactly once.
   */
  onDelta?: (text: string) => void;
};

/**
 * Production connection: one chunked POST to the live route. No Content-Length
 * is ever set - Node then uses `Transfer-Encoding: chunked`, the only body
 * framing the server accepts on this route.
 */
export function defaultLiveConnect(baseUrl: string, handlers: LiveSseHandlers): LiveConnection {
  const url = new URL(`/v1/audio/transcriptions/live?model=${STT_SERVER_MODEL_ID}`, baseUrl);
  const req = httpRequest(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'audio/pcm', Accept: 'text/event-stream' },
    },
    (res) => {
      handlers.status(res.statusCode ?? 0);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => handlers.data(chunk));
      res.on('end', () => handlers.end());
      res.on('error', (err: Error) => handlers.error(err));
    }
  );
  req.on('error', (err: Error) => handlers.error(err));
  return {
    write: (chunk) => {
      req.write(Buffer.from(chunk));
    },
    end: () => {
      req.end();
    },
    destroy: () => {
      req.destroy();
    },
  };
}

/** Wrap raw 16 kHz mono s16le PCM in a canonical 44-byte WAV header. */
export function pcmToWav(pcm: Buffer): Buffer {
  const byteRate = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * PCM_CHANNELS;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(PCM_CHANNELS, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(PCM_BYTES_PER_SAMPLE * PCM_CHANNELS, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Shape of one parsed SSE `data:` payload from the live route. */
type LiveSsePayload = {
  type?: unknown;
  text?: unknown;
  delta?: unknown;
  error?: unknown;
};

/**
 * One live dictation session: a single chunked request feeding PCM in while
 * SSE deltas stream out. Internal to {@link NemotronLive}.
 */
class NemotronLiveSession {
  private readonly deps: NemotronLiveDeps;
  private readonly emitPartial: (text: string) => void;

  private connection: LiveConnection | null = null;
  /** Chunks pushed while the server was still starting; flushed on connect. */
  private pending: Buffer[] = [];
  /** Everything pushed, kept for the batch fallback (capped). */
  private fallbackPcm: Buffer[] = [];
  private fallbackBytes = 0;

  private partial = '';
  private finalText: string | null = null;
  private sseTail = '';

  private broken = false;
  private brokenDetail = '';
  private cancelled = false;
  private bodyEnded = false;
  /** stop() reached its decision point - late SSE/socket events are ignored. */
  private settled = false;

  private streamEnded = false;
  private streamEndResolvers: Array<() => void> = [];

  constructor(deps: NemotronLiveDeps, emitPartial: (text: string) => void) {
    this.deps = deps;
    this.emitPartial = emitPartial;
  }

  /** Start the server (when needed) and open the live connection. */
  async open(): Promise<void> {
    const baseUrl = await this.deps.ensureRunning();
    if (this.cancelled || this.settled) return;
    this.connection = this.deps.connect(baseUrl, {
      status: (statusCode) => {
        if (statusCode !== 200) this.markBroken(`live HTTP ${String(statusCode)}`);
      },
      data: (chunk) => this.onSseData(chunk),
      end: () => this.resolveStreamEnd(),
      error: (err) => this.markBroken(errText(err)),
    });
    for (const chunk of this.pending) this.connection.write(chunk);
    this.pending = [];
  }

  /** Feed one raw PCM chunk (16 kHz mono s16le). Never throws, never blocks. */
  pushChunk(pcm: Uint8Array): void {
    if (this.cancelled || this.bodyEnded || pcm.length === 0) return;
    const buf = Buffer.from(pcm);
    if (this.fallbackBytes + buf.length <= MAX_FALLBACK_BYTES) {
      this.fallbackPcm.push(buf);
      this.fallbackBytes += buf.length;
    }
    if (this.broken) return;
    if (this.connection !== null) {
      this.connection.write(buf);
    } else {
      this.pending.push(buf);
    }
  }

  /**
   * Finish the session: end the body, wait for the server's `done`, and
   * resolve the final text. A broken live path (or an empty live result)
   * falls back to batch transcription of the buffered PCM.
   */
  async stop(): Promise<string> {
    if (!this.bodyEnded) {
      this.bodyEnded = true;
      if (this.connection !== null && !this.broken) this.connection.end();
    }

    let streamClosed = true;
    if (!this.broken && this.connection !== null) {
      streamClosed = await this.waitForStreamEnd(this.deps.stopTimeoutMs);
    }
    this.settled = true;
    if (!streamClosed) {
      // The server never sent `done` within the budget: reap the socket and
      // use whatever partial accumulated (the reference behaviour).
      this.connection?.destroy();
    }

    const liveText = (this.finalText ?? this.partial).trim();
    if (!this.broken && liveText.length > 0) {
      return glossfix(liveText);
    }

    // Live path yielded nothing - transcribe the buffered audio offline.
    if (this.fallbackBytes > 0) {
      const pcm = Buffer.concat(this.fallbackPcm);
      this.fallbackPcm = [];
      this.fallbackBytes = 0;
      try {
        return await this.deps.batchTranscribe(pcmToWav(pcm));
      } catch (error) {
        // Typed errors (NemotronSttError, AudioCppUnavailableError) already
        // carry a renderer-stable code - let them through unchanged.
        if (error instanceof Error && 'code' in error) throw error;
        throw new NemotronLiveError(
          'NEMOTRON_MN_LIVE_FAILED',
          `live: ${this.brokenDetail || 'no text produced'}; fallback: ${errText(error)}`
        );
      }
    }
    if (this.broken) {
      throw new NemotronLiveError('NEMOTRON_MN_LIVE_FAILED', this.brokenDetail);
    }
    return '';
  }

  /** Abort the session and discard all buffered audio. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.settled = true;
    this.connection?.destroy();
    this.connection = null;
    this.pending = [];
    this.fallbackPcm = [];
    this.fallbackBytes = 0;
    this.resolveStreamEnd();
  }

  private onSseData(chunk: string): void {
    if (this.cancelled || this.settled) return;
    this.sseTail += chunk;
    const lines = this.sseTail.split('\n');
    this.sseTail = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      let payload: LiveSsePayload;
      try {
        payload = JSON.parse(line.slice(5).trim()) as LiveSsePayload;
      } catch {
        continue;
      }
      const kind = typeof payload.type === 'string' ? payload.type : '';
      if (kind === 'error') {
        this.markBroken(`server error event: ${errText(payload.error)}`);
        return;
      }
      // The `done` event repeats the WHOLE text: replace, never append (the
      // reference parser also accepts a text-without-delta event as final).
      const text = typeof payload.text === 'string' ? payload.text : '';
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      if (kind.includes('done') || (text.length > 0 && delta.length === 0)) {
        this.finalText = (text.length > 0 ? text : this.partial).trim();
        continue;
      }
      if (delta.length > 0) {
        this.partial += delta;
        this.emitPartial(this.partial);
      }
    }
  }

  private markBroken(detail: string): void {
    if (this.broken || this.cancelled || this.settled) return;
    this.broken = true;
    this.brokenDetail = detail;
    this.connection?.destroy();
    this.resolveStreamEnd();
  }

  private waitForStreamEnd(timeoutMs: number): Promise<boolean> {
    if (this.streamEnded || this.broken) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.streamEndResolvers.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private resolveStreamEnd(): void {
    this.streamEnded = true;
    const resolvers = this.streamEndResolvers;
    this.streamEndResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

/**
 * Batch fallback via the NemotronStt path. Imported LAZILY: NemotronStt's
 * module graph reaches `videoFrames -> initStorage -> electron.safeStorage`,
 * which only resolves inside the Electron main process - a static import here
 * would make this module unusable from bun-run verification scripts (the same
 * reason scripts/verify-mongol-voice.ts avoids importing NemotronStt).
 */
async function defaultBatchTranscribe(wav: Buffer): Promise<string> {
  const { NemotronStt } = await import('./NemotronStt');
  const result = await NemotronStt.transcribe({
    audioBuffer: wav,
    fileName: 'live-fallback.wav',
    mimeType: 'audio/wav',
  });
  return result.text;
}

function defaultNemotronLiveDeps(): NemotronLiveDeps {
  return {
    ensureRunning: () => audioCppServer.ensureRunning(),
    connect: defaultLiveConnect,
    batchTranscribe: defaultBatchTranscribe,
    stopTimeoutMs: STOP_TIMEOUT_MS,
  };
}

/**
 * Live dictation session manager: at most ONE session at a time. A new
 * start() cancels the previous session (last caller wins - the renderer's
 * mic owns the single dictation surface).
 */
export class NemotronLive {
  private readonly deps: NemotronLiveDeps;
  private session: NemotronLiveSession | null = null;

  constructor(deps?: Partial<NemotronLiveDeps>) {
    this.deps = { ...defaultNemotronLiveDeps(), ...deps };
  }

  /** True while a session (possibly still connecting) is active. */
  isActive(): boolean {
    return this.session !== null;
  }

  /**
   * Open a new live session, cancelling any previous one. Rejects with the
   * server's typed error (NEMOTRON_MN_NOT_INSTALLED / NEMOTRON_MN_START_*)
   * when the audio.cpp server cannot come up.
   */
  async start(events?: NemotronLiveEvents): Promise<void> {
    this.session?.cancel();
    const session = new NemotronLiveSession(this.deps, (text) => events?.onDelta?.(text));
    this.session = session;
    try {
      await session.open();
    } catch (error) {
      session.cancel();
      if (this.session === session) this.session = null;
      throw error;
    }
  }

  /** Feed one raw PCM chunk (16 kHz mono s16le) into the active session. */
  pushChunk(pcm: Uint8Array): void {
    this.session?.pushChunk(pcm);
  }

  /**
   * Finish the active session and resolve its final (glossfixed) text.
   * Rejects with NEMOTRON_MN_LIVE_NOT_ACTIVE when no session is active.
   */
  async stop(): Promise<string> {
    const session = this.session;
    if (session === null) {
      throw new NemotronLiveError('NEMOTRON_MN_LIVE_NOT_ACTIVE', 'no live dictation session is active');
    }
    try {
      return await session.stop();
    } finally {
      if (this.session === session) this.session = null;
    }
  }

  /** Abort the active session (if any) and discard its buffered audio. */
  cancel(): void {
    this.session?.cancel();
    this.session = null;
  }
}

/** App-wide singleton: the one live dictation session the IPC bridge drives. */
export const nemotronLive = new NemotronLive();

// An active dictation session must not outlive the server that owns its
// socket: the app-quit path stops the audio.cpp server through
// stopAudioCppServer, which fires this listener first.
registerAudioCppServerStopListener(() => {
  nemotronLive.cancel();
});
