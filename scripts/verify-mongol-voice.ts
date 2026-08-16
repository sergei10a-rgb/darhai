/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Full-stack, real-artefact verification of the Mongolian voice core.
 *
 * What "real" means here: the REAL pinned archives (audio.cpp CPU zip, the
 * 931 MB Nemotron GGUF, the 726 MB kitten TTS bundle) are served over a
 * local HTTP server and installed by the REAL MongolVoiceProvisioner into a
 * scratch userData dir - full download, streamed sha256, extraction,
 * receipts. Then the REAL servers are spawned from that install and asked to
 * do real work: transcribe a Mongolian wav and synthesise Mongolian speech.
 * Unit tests fake every boundary; this script fakes none of them.
 *
 * NOT part of the vitest suite: it moves ~1.7 GB and takes minutes. Run it
 * manually before publishing the `voice-v1` release assets:
 *
 *   bun scripts/verify-mongol-voice.ts
 *
 * Source files it serves are this machine's build outputs (see SOURCES);
 * their hashes must equal the manifest pins, which is itself part of the
 * verification: a drifted local file fails the provisioner's digest gate.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MongolVoiceProvisioner } from '../src/process/services/voice/mongol/MongolVoiceProvisioner';
import {
  STT_MODEL_ASSET,
  STT_RUNTIME_ASSET,
  TTS_BUNDLE_ASSET,
  type MongolVoicePinnedAsset,
} from '../src/process/services/voice/mongol/manifest';
import { AudioCppServer, STT_SERVER_MODEL_ID } from '../src/process/services/voice/mongol/AudioCppServer';
// NemotronStt itself is NOT imported here: its module graph reaches
// `videoFrames → initStorage → electron.safeStorage`, a static electron
// import that only resolves inside the Electron main process (bun sees the
// stub `node_modules/electron/index.js`). Its request/parse logic is covered
// by unit tests; this script exercises the REAL server + model over the same
// HTTP surface, plus the same glossfix pass.
import { glossfix } from '../src/process/services/voice/mongol/glossfix';
import { KittenTtsServer } from '../src/process/services/voice/mongol/KittenTtsServer';
import { KittenTts } from '../src/process/services/voice/mongol/KittenTts';
import { normalizeTextToSpeechConfig } from '../src/common/types/ttsTypes';

/**
 * Local files standing in for the release assets, keyed by component.
 *
 * All three live in stable sibling workspaces (never a session temp dir):
 * the audio.cpp zip is the upstream release-0.6 artefact re-verified against
 * the manifest pin, the other two are the build outputs the release will
 * publish. Once `voice-v1` is published this script can also be pointed at
 * the real URLs by simply not overriding `assets`.
 */
const SOURCES: Record<string, string> = {
  'stt-runtime': String.raw`C:\claude\audiocpp-models\audiocpp-windows-cpu-balance-bb15edd7.zip`,
  'stt-model': String.raw`C:\claude\audiocpp-models\Nemotron-3.5-ASR-Streaming-0.6B-GGUF\nemotron-3.5-asr-streaming-0.6b-q8_0.gguf`,
  'tts-bundle': String.raw`C:\claude\kitten-mn\_refwork\kitten-mn-tts-cpu-v1.zip`,
};

const TEST_WAV = String.raw`C:\claude\mn-asr\data\cv_mn\cv_000007.wav`;
/** What the model transcribed this clip as in every prior measured run. */
const EXPECTED_STT_SUBSTRING = 'Должин';

const log = (msg: string): void => {
  process.stdout.write(`[e2e] ${msg}\n`);
};

/** Serve the three source files on a loopback port, path = /<component>. */
function startAssetServer(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const component = (req.url ?? '').replace(/^\//, '');
    const file = SOURCES[component];
    if (!file || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-length': statSync(file).size });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

async function main(): Promise<number> {
  for (const [component, file] of Object.entries(SOURCES)) {
    if (!existsSync(file)) {
      log(`ALGA: ${component} source missing: ${file}`);
      return 1;
    }
  }

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'darhai-voice-e2e-'));
  log(`userData: ${userDataDir}`);
  const assetServer = await startAssetServer();
  log(`asset server: http://127.0.0.1:${assetServer.port}/`);

  const localAssets: MongolVoicePinnedAsset[] = [STT_RUNTIME_ASSET, STT_MODEL_ASSET, TTS_BUNDLE_ASSET].map((asset) => ({
    ...asset,
    url: `http://127.0.0.1:${assetServer.port}/${asset.component}`,
  }));

  const provisioner = new MongolVoiceProvisioner(userDataDir, { assets: localAssets });
  let lastLoggedPct = -10;
  provisioner.on('progress', (p) => {
    const pct = p.bytesTotal !== null && p.bytesTotal > 0 ? Math.floor((p.bytesDone / p.bytesTotal) * 100) : 0;
    if (p.phase !== 'download' || pct >= lastLoggedPct + 10) {
      lastLoggedPct = p.phase === 'download' ? pct : -10;
      log(`  ${p.component} ${p.phase} ${pct}%`);
    }
  });

  for (const component of ['stt-runtime', 'stt-model', 'tts-bundle'] as const) {
    const t0 = Date.now();
    await provisioner.install(component);
    log(`${component} installed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  assetServer.close();

  const status = provisioner.status();
  const allInstalled =
    status['stt-runtime'].installed === true &&
    status['stt-model'].installed === true &&
    status['tts-bundle'].installed === true;
  if (!allInstalled) {
    log(`СТАТУС БУРУУ: ${JSON.stringify(status)}`);
    return 1;
  }
  log('status(): 3/3 installed');

  // Both servers stop on EVERY exit path - a failed run must not leave an
  // audiocpp_server.exe or python.exe behind (adversarial review, finding Б-5).
  const sttServer = new AudioCppServer({ userDataDir: () => userDataDir });
  const ttsServer = new KittenTtsServer({ userDataDir: () => userDataDir });
  try {
    // --- STT: real server, real Mongolian audio ---
    const wav = await readFile(TEST_WAV);
    const t1 = Date.now();
    const baseUrl = await sttServer.ensureRunning();
    const form = new FormData();
    form.append('model', STT_SERVER_MODEL_ID);
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'test.wav');
    const sttRes = await fetch(`${baseUrl}/v1/audio/transcriptions`, { method: 'POST', body: form });
    if (!sttRes.ok) {
      log(`STT HTTP ${sttRes.status}`);
      return 1;
    }
    const sttPayload = (await sttRes.json()) as { text?: string };
    const sttText = glossfix(typeof sttPayload.text === 'string' ? sttPayload.text.trim() : '');
    log(`STT ${((Date.now() - t1) / 1000).toFixed(1)}s: "${sttText}"`);
    if (!sttText.includes(EXPECTED_STT_SUBSTRING)) {
      log(`STT ГАРАЛТ ТААРАХГҮЙ: "${EXPECTED_STT_SUBSTRING}" олдсонгүй`);
      return 1;
    }

    // --- TTS: real bundled interpreter, real synthesis ---
    const t2 = Date.now();
    const audio = await KittenTts.synthesize(
      'Дархайн монгол дуу хоолойн бүрэн шалгалт амжилттай боллоо.',
      normalizeTextToSpeechConfig({ enabled: true, provider: 'kitten-mn' }),
      { server: ttsServer, fetch: (url, init) => globalThis.fetch(url, init) }
    );
    const outWav = path.join(userDataDir, 'e2e-tts.wav');
    await writeFile(outWav, audio.data);
    log(`TTS ${((Date.now() - t2) / 1000).toFixed(1)}s: ${audio.data.byteLength} bytes -> ${outWav}`);
    if (audio.data.byteLength < 50_000) {
      log('TTS ГАРАЛТ ХЭТ БОГИНО - дуу гараагүй байж магадгүй');
      return 1;
    }
  } finally {
    await sttServer.stop().catch(() => undefined);
    await ttsServer.stop().catch(() => undefined);
  }

  log('PASS: татах -> шалгах -> задлах -> асаах -> таних -> ярих бүгд бодитоор ажиллав');
  log(`(үлдээв: ${userDataDir} - гараар сонирхож болно, дараа нь устгаарай)`);
  // Keep the install for inspection; caller decides when to delete.
  void rm;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`УНАЛАА: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
