/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * - `'kitten-mn'`   - Mongolian StyleTTS2 student model served by a bundled
 *                     local HTTP service (CPU ONNX). The default: it is the
 *                     only provider that actually speaks Mongolian.
 * - `'system-native'` - macOS `say`. Only meaningful on darwin; other
 *                     platforms return empty audio, so the UI gates it.
 * - `'kokoro-local'` - legacy entry kept so stored configs keep parsing.
 *                     It never worked (the CLI it shells out to does not
 *                     exist) and is hidden from the UI; synthesis reports a
 *                     typed error instead of silence.
 */
export type TextToSpeechProvider = 'kitten-mn' | 'kokoro-local' | 'system-native';

export type TextToSpeechConfig = {
  enabled: boolean;
  provider: TextToSpeechProvider;
  voice: string;
  speed: number; // 0.5–2.0
  autoReadResponses: boolean;
};

export const DEFAULT_TTS_CONFIG: TextToSpeechConfig = {
  enabled: false,
  provider: 'kitten-mn',
  voice: 'default',
  // 1.4: serge listened to the kitten-mn output at 1.0 and asked for this
  // (2026-08-16) - the model's natural pace reads slower than his preference.
  speed: 1.4,
  autoReadResponses: false,
};

/** Merges supplied config over defaults so old/absent configs upgrade cleanly. */
export const normalizeTextToSpeechConfig = (config?: Partial<TextToSpeechConfig>): TextToSpeechConfig => {
  const merged = { ...DEFAULT_TTS_CONFIG, ...config };
  // 'kokoro-local' never produced audio (its CLI never existed), so a stored
  // selection of it carries no user intent worth preserving - upgrade it to
  // the working default instead of surfacing a dead provider.
  if (merged.provider === 'kokoro-local') {
    merged.provider = 'kitten-mn';
  }
  return merged;
};

/** Audio bytes returned from any TTS synthesis call. */
export type TextToSpeechAudio = {
  /** Raw PCM / encoded audio data. */
  data: Uint8Array;
  /** MIME type of the audio, e.g. 'audio/wav'. */
  mimeType: string;
};
