/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real-artefact verification of LIVE dictation (docs/architecture/
 * mongolian-voice.md): the REAL audio.cpp server is started from the install
 * that scripts/verify-mongol-voice.ts produced, and a REAL Mongolian clip is
 * streamed through {@link NemotronLive} as raw PCM in 100 ms chunks at
 * real-time speed - exactly what the renderer's microphone path will do.
 * Unit tests fake the HTTP/SSE boundary; this script fakes nothing.
 *
 * Measured and printed: time to first delta (perceived dictation latency),
 * every delta with its timestamp, and the tail latency from end-of-audio to
 * the final text. The run FAILS unless the final text contains the known
 * transcript of the clip and the live path (not the batch fallback) produced
 * it.
 *
 * NOT part of the vitest suite (starts a real server, takes ~15 s):
 *
 *   bun scripts/verify-live-dictation.ts
 *
 * Prerequisite: the extracted voice install at {@link E2E_USER_DATA} (run
 * `bun scripts/verify-mongol-voice.ts` first if it is missing).
 *
 * NemotronStt (the production batch fallback) is deliberately NOT imported:
 * its module graph reaches electron.safeStorage, which bun cannot resolve
 * (same constraint as verify-mongol-voice.ts). The injected fallback throws
 * instead - this script exists to prove the LIVE path works.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { AudioCppServer } from '../src/process/services/voice/mongol/AudioCppServer';
import { NemotronLive } from '../src/process/services/voice/mongol/NemotronLive';

const E2E_USER_DATA = String.raw`C:\Users\serge\AppData\Local\Temp\darhai-voice-e2e-N9lMLB`;
const TEST_WAV = String.raw`C:\claude\mn-asr\data\cv_mn\cv_000007.wav`;
/** What the model transcribed this clip as in every prior measured run. */
const EXPECTED_STT_SUBSTRING = 'Должин';
const CHUNK_MS = 100;

const log = (msg: string): void => {
  process.stdout.write(`[live-e2e] ${msg}\n`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type ParsedWav = { sampleRate: number; channels: number; bitsPerSample: number; pcm: Buffer };

/** Minimal RIFF walk: read `fmt ` and `data` chunks, reject anything exotic. */
function parseWav(file: Buffer): ParsedWav {
  if (file.subarray(0, 4).toString('ascii') !== 'RIFF' || file.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  let pcm: Buffer | null = null;
  while (offset + 8 <= file.length) {
    const id = file.subarray(offset, offset + 4).toString('ascii');
    const size = file.readUInt32LE(offset + 4);
    const body = file.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      pcm = body;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (fmt === null || pcm === null) throw new Error('missing fmt/data chunk');
  return { ...fmt, pcm };
}

async function main(): Promise<number> {
  if (!existsSync(E2E_USER_DATA)) {
    log(`ALGA: E2E install missing: ${E2E_USER_DATA}`);
    log('Run `bun scripts/verify-mongol-voice.ts` first to produce it.');
    return 1;
  }
  if (!existsSync(TEST_WAV)) {
    log(`ALGA: test clip missing: ${TEST_WAV}`);
    return 1;
  }

  const wav = parseWav(await readFile(TEST_WAV));
  if (wav.sampleRate !== 16_000 || wav.channels !== 1 || wav.bitsPerSample !== 16) {
    log(`CLIP FORMAT БУРУУ: ${wav.sampleRate} Hz, ${wav.channels} ch, ${wav.bitsPerSample} bit (need 16000/1/16)`);
    return 1;
  }
  const audioMs = (wav.pcm.length / 2 / wav.sampleRate) * 1000;
  log(`clip: ${audioMs.toFixed(0)} ms of 16 kHz mono s16le (${wav.pcm.length} bytes)`);

  const server = new AudioCppServer({ userDataDir: () => E2E_USER_DATA });
  try {
    const live = new NemotronLive({
      ensureRunning: () => server.ensureRunning(),
      batchTranscribe: async () => {
        throw new Error('E2E: batch fallback was invoked - the LIVE path failed');
      },
    });

    const tServer = Date.now();
    let firstDeltaMs: number | null = null;
    let deltaCount = 0;
    let t0 = 0;

    log('starting audio.cpp server + opening live session...');
    await live.start({
      onDelta: (text) => {
        const ms = Date.now() - t0;
        if (firstDeltaMs === null) firstDeltaMs = ms;
        deltaCount += 1;
        log(`  [${String(ms).padStart(6)} ms] partial: "${text}"`);
      },
    });
    log(`session open in ${Date.now() - tServer} ms (server start included)`);

    // Stream at real-time speed, the way a microphone would deliver it.
    const step = (wav.sampleRate * CHUNK_MS * 2) / 1000;
    t0 = Date.now();
    for (let i = 0; i < wav.pcm.length; i += step) {
      live.pushChunk(wav.pcm.subarray(i, i + step));
      // eslint-disable-next-line no-await-in-loop -- real-time pacing is the point
      await sleep(CHUNK_MS);
    }
    const tAudioEnd = Date.now();

    const finalText = await live.stop();
    const tailMs = Date.now() - tAudioEnd;
    const totalMs = Date.now() - t0;

    log('');
    log(`final text   : "${finalText}"`);
    log(`first delta  : ${firstDeltaMs === null ? 'NONE' : `${firstDeltaMs} ms`} (deltas: ${deltaCount})`);
    log(`total        : ${totalMs} ms (audio ${audioMs.toFixed(0)} ms)`);
    log(`tail latency : ${tailMs} ms  <- end of audio to final text`);

    if (firstDeltaMs === null) {
      log('УНАЛАА: no partial text ever arrived - live streaming did not work');
      return 1;
    }
    if (!finalText.includes(EXPECTED_STT_SUBSTRING)) {
      log(`УНАЛАА: "${EXPECTED_STT_SUBSTRING}" not found in the final text`);
      return 1;
    }
    log('PASS: асаах -> live урсгал -> delta-ууд -> эцсийн текст бүгд бодитоор ажиллав');
    return 0;
  } finally {
    await server.stop().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`УНАЛАА: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
