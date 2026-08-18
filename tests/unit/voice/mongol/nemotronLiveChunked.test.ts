/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wire-level tests of {@link defaultLiveConnect} against a REAL loopback HTTP
 * server (listed in tests/osResourceTests.ts - io lane).
 *
 * The one property that must never regress: the live request body is CHUNKED.
 * audio.cpp rejects a Content-Length body on the /live route with HTTP 400
 * (measured in mn-asr-app; a hand-rolled `%x\r\n` framing stalled), so the
 * request must carry `Transfer-Encoding: chunked` and NO Content-Length -
 * which Node's ClientRequest does exactly when no Content-Length is set.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { NemotronLive, defaultLiveConnect, type NemotronLiveDeps } from '@process/services/voice/mongol/NemotronLive';
import { STT_SERVER_MODEL_ID } from '@process/services/voice/mongol/AudioCppServer';

type CapturedRequest = {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

/** Per-test behaviour switch: which SSE script the server answers with. */
let mode: 'done' | 'error' = 'done';
const captured: CapturedRequest[] = [];

let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mode === 'error') {
        res.write('data: {"type":"error","error":"idle timeout"}\n\n');
      } else {
        res.write('data: {"type":"transcript.delta","delta":"сайн"}\n\n');
        res.write('data: {"type":"transcript.delta","delta":" уу"}\n\n');
        res.write('data: {"type":"transcript.done","text":"сайн уу"}\n\n');
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function liveOver(batch: NemotronLiveDeps['batchTranscribe']): NemotronLive {
  return new NemotronLive({
    ensureRunning: async () => baseUrl,
    connect: defaultLiveConnect,
    batchTranscribe: batch,
    stopTimeoutMs: 5_000,
  });
}

describe('defaultLiveConnect over a real loopback server', () => {
  it('sends a CHUNKED body (no Content-Length ever) to the /live route with the model in the query', async () => {
    mode = 'done';
    captured.length = 0;
    const batch = vi.fn(async () => 'batch-must-not-run');
    const live = liveOver(batch);
    const deltas: string[] = [];

    await live.start({ onDelta: (text) => deltas.push(text) });
    const pcm1 = Uint8Array.from([1, 2, 3, 4]);
    const pcm2 = Uint8Array.from([5, 6, 7, 8, 9, 10]);
    live.pushChunk(pcm1);
    live.pushChunk(pcm2);
    const text = await live.stop();

    expect(captured).toHaveLength(1);
    const req = captured[0];
    // The load-bearing property: chunked framing, never Content-Length.
    expect(req.headers['transfer-encoding']).toBe('chunked');
    expect(req.headers['content-length']).toBeUndefined();
    expect(req.url).toBe(`/v1/audio/transcriptions/live?model=${STT_SERVER_MODEL_ID}`);
    expect(req.headers['content-type']).toBe('audio/pcm');
    expect(req.headers.accept).toBe('text/event-stream');
    // The raw PCM crossed the wire intact.
    expect(Array.from(req.body)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    expect(deltas).toEqual(['сайн', 'сайн уу']);
    expect(text).toBe('сайн уу');
    expect(batch).not.toHaveBeenCalled();
  });

  it('recovers over the real transport when the server answers with an SSE error payload', async () => {
    mode = 'error';
    captured.length = 0;
    const batch = vi.fn(async () => 'нөөц зам');
    const live = liveOver(batch);

    await live.start({});
    live.pushChunk(Uint8Array.from([11, 12, 13, 14]));
    const text = await live.stop();

    expect(text).toBe('нөөц зам');
    expect(batch).toHaveBeenCalledTimes(1);
    const wav = batch.mock.calls[0][0] as Buffer;
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(Array.from(wav.subarray(44))).toEqual([11, 12, 13, 14]);
  });
});
