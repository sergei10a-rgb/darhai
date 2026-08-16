/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TextToSpeechAudio, TextToSpeechConfig } from '@/common/types/ttsTypes';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KittenTts, type KittenTtsRuntime } from '@process/services/voice/mongol/KittenTts';

const execFileAsync = promisify(execFile);

/**
 * Thrown when a stored config still routes to the retired `kokoro-local`
 * provider. That provider never produced audio: its pinned binary downloads
 * all return 404 and the CLI interface it shelled out to never existed (see
 * docs/architecture/mongolian-voice.md). A typed error is deliberate - the
 * old path failed silently, which is the worse behaviour.
 */
export class KokoroRemovedError extends Error {
  readonly code = 'TTS_KOKORO_REMOVED';

  constructor() {
    super(
      'TTS_KOKORO_REMOVED: the kokoro-local provider was retired because it never worked - ' +
        'its pinned binary URLs all return 404 and the CLI it invoked never existed ' +
        '(docs/architecture/mongolian-voice.md). Use the kitten-mn provider instead.'
    );
    this.name = 'KokoroRemovedError';
  }
}

/**
 * Thrown for `system-native` on a platform without the macOS `say` command.
 * The previous behaviour - returning zero bytes of "audio" - made a
 * misconfigured Windows install look like a healthy one that had nothing to
 * say, which is how the whole inherited voice layer stayed broken unnoticed
 * (docs/architecture/mongolian-voice.md). Silence is the worse failure.
 */
export class SystemNativeUnsupportedError extends Error {
  readonly code = 'TTS_SYSTEM_NATIVE_UNSUPPORTED';

  constructor() {
    super(
      'TTS_SYSTEM_NATIVE_UNSUPPORTED: the system-native provider uses the macOS `say` command ' +
        'and cannot run on this platform. Use the kitten-mn provider instead.'
    );
    this.name = 'SystemNativeUnsupportedError';
  }
}

/**
 * Synthesizes speech via the macOS `say` command, capturing audio output.
 * Zero-download fallback - available on every macOS install.
 */
const synthesizeSystemNative = async (text: string, config: TextToSpeechConfig): Promise<TextToSpeechAudio> => {
  // `say` writes AIFF to stdout when given `-o /dev/stdout --data-format=aiff`
  // but that only works on macOS.
  if (process.platform !== 'darwin') {
    throw new SystemNativeUnsupportedError();
  }
  const rate = Math.round(config.speed * 175); // macOS default ~175 wpm
  const args = ['-r', String(rate), '--output-file=/dev/stdout', '--data-format=aiff', text];
  const { stdout } = await execFileAsync('say', args, {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { data: new Uint8Array(stdout), mimeType: 'audio/aiff' };
};

/**
 * Routes synthesis requests to the appropriate backend based on `config.provider`.
 *
 * - `'kitten-mn'`     → KittenTts (local Mongolian TTS server; the default)
 * - `'system-native'` → macOS `say` command (zero-download fallback)
 * - `'kokoro-local'`  → typed {@link KokoroRemovedError}; the provider never
 *                       worked and is kept in the union only so stored configs
 *                       keep parsing (normalize upgrades them to kitten-mn).
 *
 * @param text   Plain text to synthesize.
 * @param config TTS configuration (provider, voice, speed, …).
 * @param kittenRuntime Injectable seam for unit tests; defaults to production runtime.
 */
export const synthesize = async (
  text: string,
  config: TextToSpeechConfig,
  kittenRuntime?: KittenTtsRuntime
): Promise<TextToSpeechAudio> => {
  switch (config.provider) {
    case 'kitten-mn':
      return KittenTts.synthesize(text, config, kittenRuntime);
    case 'kokoro-local':
      throw new KokoroRemovedError();
    case 'system-native':
      return synthesizeSystemNative(text, config);
  }
};
