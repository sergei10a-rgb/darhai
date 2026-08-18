/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * NemotronLive session-manager tests. The HTTP/SSE boundary and the batch
 * fallback are injected fakes; what is asserted is the CONTRACT the renderer
 * and the reference implementation (mn-asr-app `_LiveHandle`) depend on:
 *   - deltas accumulate and every onDelta carries the FULL partial (replace,
 *     not append, on the renderer side)
 *   - the `done` event REPEATS the whole text - it must replace the partial,
 *     never be appended to it (else the text doubles)
 *   - an SSE-carried error (HTTP 200 stays 200) becomes a TYPED error
 *   - a broken live path falls back to batch transcription of the buffered
 *     PCM, wrapped as a valid 16 kHz mono s16le WAV
 *   - one session at a time: a second start() cancels the first
 *   - stopAudioCppServer fires registered stop listeners (app-quit cleanup)
 */

import { describe, expect, it, vi } from 'vitest';

import {
  NemotronLive,
  NemotronLiveError,
  pcmToWav,
  type LiveConnection,
  type LiveSseHandlers,
  type NemotronLiveDeps,
} from '@process/services/voice/mongol/NemotronLive';
import { registerAudioCppServerStopListener, stopAudioCppServer } from '@process/services/voice/mongol/AudioCppServer';

const BASE_URL = 'http://127.0.0.1:1';

type FakeConn = {
  handlers: LiveSseHandlers;
  writes: Buffer[];
  ended: boolean;
  destroyed: boolean;
};

type Harness = {
  deps: NemotronLiveDeps;
  conns: FakeConn[];
  batch: ReturnType<typeof vi.fn>;
};

function makeHarness(overrides?: Partial<NemotronLiveDeps>): Harness {
  const conns: FakeConn[] = [];
  const batch = vi.fn(async () => 'batch-текст');
  const deps: NemotronLiveDeps = {
    ensureRunning: async () => BASE_URL,
    connect: (_baseUrl: string, handlers: LiveSseHandlers): LiveConnection => {
      const conn: FakeConn = { handlers, writes: [], ended: false, destroyed: false };
      conns.push(conn);
      return {
        write: (chunk) => {
          conn.writes.push(Buffer.from(chunk));
        },
        end: () => {
          conn.ended = true;
        },
        destroy: () => {
          conn.destroyed = true;
        },
      };
    },
    batchTranscribe: batch,
    stopTimeoutMs: 50,
    ...overrides,
  };
  return { deps, conns, batch };
}

/** Push one SSE event line into a fake connection. */
function sse(conn: FakeConn, payload: Record<string, unknown>): void {
  conn.handlers.data(`data: ${JSON.stringify(payload)}\n\n`);
}

describe('NemotronLive delta aggregation', () => {
  it('emits the FULL accumulated partial on every delta (replacement contract)', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    const onDelta = vi.fn();
    await live.start({ onDelta });

    const conn = h.conns[0];
    conn.handlers.status(200);
    sse(conn, { type: 'transcript.delta', delta: 'сайн' });
    sse(conn, { type: 'transcript.delta', delta: ' байна' });

    expect(onDelta.mock.calls.map((c) => c[0])).toEqual(['сайн', 'сайн байна']);
    live.cancel();
  });

  it('parses SSE lines split across data chunks', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    const onDelta = vi.fn();
    await live.start({ onDelta });

    const conn = h.conns[0];
    conn.handlers.status(200);
    conn.handlers.data('data: {"type":"transcript.delta","del');
    expect(onDelta).not.toHaveBeenCalled();
    conn.handlers.data('ta":"аб"}\n');
    expect(onDelta).toHaveBeenCalledWith('аб');
    live.cancel();
  });
});

describe('NemotronLive done handling', () => {
  it('the done event REPLACES the partial - the final text is never doubled', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    await live.start({});

    const conn = h.conns[0];
    conn.handlers.status(200);
    sse(conn, { type: 'transcript.delta', delta: 'сайн' });
    sse(conn, { type: 'transcript.delta', delta: ' байна уу' });
    sse(conn, { type: 'transcript.done', text: 'сайн байна уу' });
    conn.handlers.end();

    const text = await live.stop();
    expect(text).toBe('сайн байна уу');
    expect(h.batch).not.toHaveBeenCalled();
  });

  it('an event carrying text without delta is also treated as final (reference parser rule)', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    await live.start({});

    const conn = h.conns[0];
    conn.handlers.status(200);
    sse(conn, { type: 'transcript.delta', delta: 'нэг хоёр' });
    sse(conn, { text: 'нэг хоёр гурав' });
    conn.handlers.end();

    await expect(live.stop()).resolves.toBe('нэг хоёр гурав');
  });

  it('applies glossfix to the final text', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    await live.start({});

    const conn = h.conns[0];
    conn.handlers.status(200);
    sse(conn, { type: 'transcript.delta', delta: 'гугл хайлаа' });
    sse(conn, { type: 'transcript.done', text: 'гугл хайлаа' });
    conn.handlers.end();

    await expect(live.stop()).resolves.toBe('Google хайлаа');
  });

  it('falls back to the accumulated partial when the stream ends without a done event', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    await live.start({});

    const conn = h.conns[0];
    conn.handlers.status(200);
    sse(conn, { type: 'transcript.delta', delta: 'хагас үр дүн' });
    conn.handlers.end();

    await expect(live.stop()).resolves.toBe('хагас үр дүн');
    expect(h.batch).not.toHaveBeenCalled();
  });
});

describe('NemotronLive SSE error handling', () => {
  it('an SSE-carried error with nothing to fall back on rejects with a typed error', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    await live.start({});

    const conn = h.conns[0];
    conn.handlers.status(200);
    sse(conn, { type: 'error', error: 'decode failed' });

    const failure = await live.stop().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NemotronLiveError);
    expect((failure as NemotronLiveError).code).toBe('NEMOTRON_MN_LIVE_FAILED');
    expect((failure as Error).message).toMatch(/^NEMOTRON_MN_LIVE_FAILED:/);
    expect((failure as Error).message).toContain('decode failed');
  });

  it('an SSE-carried error discards the partial and uses the batch fallback when PCM is buffered', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    await live.start({});

    const conn = h.conns[0];
    conn.handlers.status(200);
    live.pushChunk(Uint8Array.from([1, 2, 3, 4]));
    sse(conn, { type: 'transcript.delta', delta: 'тас' });
    sse(conn, { type: 'error', error: 'idle timeout' });

    await expect(live.stop()).resolves.toBe('batch-текст');
    expect(h.batch).toHaveBeenCalledTimes(1);
  });

  it('wraps a non-typed fallback failure into NemotronLiveError carrying both details', async () => {
    const h = makeHarness();
    h.batch.mockRejectedValueOnce(new Error('server gone'));
    const live = new NemotronLive(h.deps);
    await live.start({});

    const conn = h.conns[0];
    conn.handlers.status(200);
    live.pushChunk(Uint8Array.from([9, 9]));
    sse(conn, { type: 'error', error: 'decode failed' });

    const failure = await live.stop().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NemotronLiveError);
    expect((failure as Error).message).toContain('decode failed');
    expect((failure as Error).message).toContain('server gone');
  });
});

describe('NemotronLive live breakage -> batch fallback', () => {
  it('a socket error mid-stream falls back to batch over the buffered PCM as a 16 kHz mono WAV', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    await live.start({});

    const conn = h.conns[0];
    conn.handlers.status(200);
    const chunk1 = Uint8Array.from([1, 2, 3, 4]);
    const chunk2 = Uint8Array.from([5, 6]);
    live.pushChunk(chunk1);
    live.pushChunk(chunk2);
    sse(conn, { type: 'transcript.delta', delta: 'сай' });
    conn.handlers.error(new Error('socket hang up'));

    await expect(live.stop()).resolves.toBe('batch-текст');
    expect(h.batch).toHaveBeenCalledTimes(1);

    const wav = h.batch.mock.calls[0][0] as Buffer;
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(Array.from(wav.subarray(44))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a non-200 HTTP answer marks the live path broken and falls back', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    await live.start({});

    const conn = h.conns[0];
    conn.handlers.status(400);
    live.pushChunk(Uint8Array.from([7, 7]));

    await expect(live.stop()).resolves.toBe('batch-текст');
    expect(h.batch).toHaveBeenCalledTimes(1);
  });

  it('buffers chunks pushed while the server is still starting and flushes them on connect', async () => {
    let release!: (url: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({ ensureRunning: () => gate });
    const live = new NemotronLive(h.deps);

    const startPromise = live.start({});
    live.pushChunk(Uint8Array.from([42, 43]));
    expect(h.conns).toHaveLength(0);

    release(BASE_URL);
    await startPromise;

    expect(h.conns).toHaveLength(1);
    expect(Array.from(h.conns[0].writes[0] ?? [])).toEqual([42, 43]);
    live.cancel();
  });
});

describe('NemotronLive session exclusivity', () => {
  it('a second start cancels the first session and silences its late events', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    const firstDelta = vi.fn();
    const secondDelta = vi.fn();

    await live.start({ onDelta: firstDelta });
    const first = h.conns[0];
    first.handlers.status(200);

    await live.start({ onDelta: secondDelta });
    expect(first.destroyed).toBe(true);

    // A late event from the cancelled session must not reach any emitter.
    sse(first, { type: 'transcript.delta', delta: 'хоцорсон' });
    expect(firstDelta).not.toHaveBeenCalled();

    const second = h.conns[1];
    second.handlers.status(200);
    sse(second, { type: 'transcript.delta', delta: 'шинэ' });
    expect(secondDelta).toHaveBeenCalledWith('шинэ');
    expect(firstDelta).not.toHaveBeenCalled();
    live.cancel();
  });

  it('stop without an active session rejects with a typed NOT_ACTIVE error', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    const failure = await live.stop().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NemotronLiveError);
    expect((failure as NemotronLiveError).code).toBe('NEMOTRON_MN_LIVE_NOT_ACTIVE');
  });

  it('cancel destroys the connection and stop afterwards reports no active session', async () => {
    const h = makeHarness();
    const live = new NemotronLive(h.deps);
    await live.start({});
    h.conns[0].handlers.status(200);
    live.pushChunk(Uint8Array.from([1]));

    live.cancel();
    expect(h.conns[0].destroyed).toBe(true);
    expect(live.isActive()).toBe(false);

    const failure = await live.stop().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NemotronLiveError);
    expect((failure as NemotronLiveError).code).toBe('NEMOTRON_MN_LIVE_NOT_ACTIVE');
    expect(h.batch).not.toHaveBeenCalled();
  });

  it('start clears the session again when the server cannot start', async () => {
    const h = makeHarness({
      ensureRunning: async () => {
        throw new Error('NEMOTRON_MN_NOT_INSTALLED: the audio.cpp STT runtime is not installed');
      },
    });
    const live = new NemotronLive(h.deps);
    await expect(live.start({})).rejects.toThrow(/^NEMOTRON_MN_NOT_INSTALLED/);
    expect(live.isActive()).toBe(false);
  });
});

describe('pcmToWav', () => {
  it('produces a canonical 44-byte header over the raw PCM payload', () => {
    const wav = pcmToWav(Buffer.from([10, 20, 30, 40]));
    expect(wav.length).toBe(48);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(40); // 36 + data bytes
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt32LE(28)).toBe(32_000); // byte rate = 16000 * 2
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(4);
  });
});

describe('AudioCppServer stop listeners (app-quit cleanup path)', () => {
  it('stopAudioCppServer fires registered listeners before stopping the server', async () => {
    const listener = vi.fn();
    registerAudioCppServerStopListener(listener);
    await stopAudioCppServer();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
