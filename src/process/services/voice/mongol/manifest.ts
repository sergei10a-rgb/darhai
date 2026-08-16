/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pinned assets for the Mongolian voice core (docs/architecture/mongolian-voice.md).
 *
 * Every asset is pinned to an exact URL, byte size, and sha256 measured on
 * 2026-08-16. Unlike `voiceAssetRegistry`, an empty hash here is NOT a
 * "download unverified and warn" - the provisioner refuses it with
 * `VOICE_HASH_UNPINNED`. These archives put executable code on disk, so an
 * unpinned entry is a bug in this table, not a looser mode.
 *
 * Performance context for the choices (measured, Ryzen 9 7845HX):
 *   - STT: audio.cpp CPU backend transcribes 12.4x faster than real time with
 *     the Nemotron Монгол v13mn Q8 GGUF (CER 15.03% on realworld_eval_clean).
 *   - TTS: the kitten-mn student model (ONNX fp32) synthesises at RTF 0.18
 *     with 4 threads, 575 MB RSS.
 * CPU is therefore the shipped default for both; no GPU is ever required.
 */

export type MongolVoiceComponent = 'stt-runtime' | 'stt-model' | 'tts-bundle';

export type MongolVoicePinnedAsset = {
  component: MongolVoiceComponent;
  /** Install directory name under the component's `versions/`. */
  tag: string;
  url: string;
  /** Hex sha256 of the payload as downloaded. Empty string = not yet pinned; the provisioner refuses to install it. */
  sha256: string;
  bytes: number;
  format: 'zip' | 'file';
  /** On-disk filename for `format: 'file'` payloads. */
  filename?: string;
};

/**
 * audio.cpp Windows CPU server, "balance" profile.
 *
 * balance = AVX2 kernels without native/AVX512 selection - upstream's
 * recommended default for compatibility. Verified on this machine: the
 * release-0.6 binary produced the identical transcript to our dev build at
 * 12.0x real time.
 */
export const STT_RUNTIME_ASSET: MongolVoicePinnedAsset = {
  component: 'stt-runtime',
  tag: 'audiocpp-0.6-cpu-balance',
  url: 'https://github.com/0xShug0/audio.cpp/releases/download/release-0.6/audiocpp-windows-cpu-balance-bb15edd7.zip',
  sha256: '3c618e98b9b780dac35033a4993f43ecf9b8da23c2634051e7ae411b4bb034af',
  bytes: 24_231_095,
  format: 'zip',
};

/** Server binary inside the extracted STT runtime; readiness keys on it. */
export const STT_SERVER_RELPATH = 'audiocpp_server.exe';

/**
 * Nemotron Монгол v13mn ASR, GGUF Q8. Converted from the NeMo fine-tune with
 * the Mongolian prompt slot baked in (`default_prompt_id=11`); the GGUF is
 * self-contained - no sidecar config travels with it.
 */
export const STT_MODEL_ASSET: MongolVoicePinnedAsset = {
  component: 'stt-model',
  tag: 'nemotron-mn-v13m-q8_0',
  url: 'https://github.com/sergei10a-rgb/darhai/releases/download/voice-v1/nemotron-mn-v13m-q8_0.gguf',
  sha256: 'e6d88cea0072ed2911f4350dfb514f94f0fdd58500643cc14f02b422d40a777f',
  bytes: 931_233_056,
  format: 'file',
  filename: 'nemotron-mn-v13m-q8_0.gguf',
};

/**
 * kitten-mn Mongolian TTS bundle: embedded CPython + ONNX student model +
 * the Mongolian G2P front-end + its FastAPI service. Darhai only depends on
 * the `bundle.json` contract at the bundle root, never on its internals.
 *
 * Built by kitten-mn `tools/build_darhai_bundle.py` on 2026-08-16 (student
 * v2 200k decoder, torch-free - proven by starting it under a poisoned
 * torch import) and verified end-to-end from a clean extraction: the
 * bundled interpreter served /api/status and synthesised WAV at RTF 0.124.
 */
export const TTS_BUNDLE_ASSET: MongolVoicePinnedAsset = {
  component: 'tts-bundle',
  tag: 'kitten-mn-tts-v1',
  url: 'https://github.com/sergei10a-rgb/darhai/releases/download/voice-v1/kitten-mn-tts-cpu-v1.zip',
  sha256: '4c664065614062a5ad35215c40b5f57b437bc08a3517008229d17f0bfa56a8d8',
  bytes: 726_089_788,
  format: 'zip',
};

export const MONGOL_VOICE_ASSETS: readonly MongolVoicePinnedAsset[] = [
  STT_RUNTIME_ASSET,
  STT_MODEL_ASSET,
  TTS_BUNDLE_ASSET,
];

/**
 * What this platform can install today.
 *
 * win32-x64 only, because that is what exists to download: audio.cpp
 * release-0.6 ships Windows-only prebuilts, and the first TTS bundle embeds
 * Windows CPython. This is a distribution gap, not a project limit - both
 * cores are portable (audio.cpp is Apache-2.0 C++; the TTS service is
 * Python + ONNX), so support widens by adding manifest rows, not code.
 */
export function mongolVoiceSupport(platform: string, arch: string): { stt: boolean; tts: boolean } {
  const isWinX64 = platform === 'win32' && arch === 'x64';
  return { stt: isWinX64, tts: isWinX64 };
}

// ---------------------------------------------------------------------------
// TTS bundle contract
// ---------------------------------------------------------------------------

/**
 * `bundle.json` at the root of an extracted TTS bundle. This file - not the
 * bundle's directory layout - is Darhai's only contract with the bundle:
 * what to spawn, how to pass the port, and where the HTTP surface lives.
 */
export type KittenBundleManifest = {
  name: string;
  version: number;
  api: 'kitten-v1';
  /** Bundle-relative path of the executable to spawn. */
  entry: string;
  /** Arguments for `entry`; the literal `{port}` is replaced with the chosen port. */
  args: string[];
  /** GET path answering 200 once the service is ready, e.g. `/api/status`. */
  healthPath: string;
  /** POST path taking `{text, voice?, speed?}` and returning `audio/wav`. */
  speakPath: string;
};

export const KITTEN_BUNDLE_MANIFEST_NAME = 'bundle.json';

/** Parse an untrusted `bundle.json`, or return null when it is not usable. */
export function parseKittenBundleManifest(raw: unknown): KittenBundleManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const isPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (r.api !== 'kitten-v1') return null;
  if (typeof r.name !== 'string' || r.name.length === 0) return null;
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) return null;
  if (!isPath(r.entry)) return null;
  if (!Array.isArray(r.args) || !r.args.every((a) => typeof a === 'string')) return null;
  if (!isPath(r.healthPath) || !r.healthPath.startsWith('/')) return null;
  if (!isPath(r.speakPath) || !r.speakPath.startsWith('/')) return null;
  return {
    name: r.name,
    version: r.version,
    api: 'kitten-v1',
    entry: r.entry,
    args: r.args,
    healthPath: r.healthPath,
    speakPath: r.speakPath,
  };
}
