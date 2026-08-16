/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * - `'nemotron-mn'` - Nemotron Монгол v13mn ASR served by a Darhai-owned local
 *                     audio.cpp server (CPU GGUF). Offline, keyless, the only
 *                     provider tuned for Mongolian.
 * - `'whisper-local'` - legacy entry kept so stored configs keep parsing. Its
 *                     pinned binary downloads all 404 (whisper.cpp v1.7.1
 *                     shipped no assets), so it is hidden from the UI.
 */
export type SpeechToTextProvider = 'openai' | 'deepgram' | 'nemotron-mn' | 'whisper-local';

export type OpenAISpeechToTextConfig = {
  apiKey: string;
  baseUrl?: string;
  language?: string;
  model: string;
  prompt?: string;
  temperature?: number;
};

export type DeepgramSpeechToTextConfig = {
  apiKey: string;
  baseUrl?: string;
  detectLanguage?: boolean;
  language?: string;
  model: string;
  punctuate?: boolean;
  smartFormat?: boolean;
};

export type WhisperLocalSpeechToTextConfig = {
  /** whisper.cpp model identifier, e.g. 'base', 'small'. The binary and model
   *  are acquired at runtime by VoiceAssetManager (task D2); absent until then. */
  model: string;
  language?: string;
};

/**
 * Nemotron Монгол v13mn has no tunable options today: the model is Mongolian-
 * only (its prompt slot is fixed at conversion time) and the server is owned
 * and configured by Darhai. The type exists so future options (e.g. streaming
 * on/off) land in config instead of code.
 */
export type NemotronMnSpeechToTextConfig = Record<string, never>;

export type SpeechToTextConfig = {
  autoSend?: boolean;
  enabled: boolean;
  provider: SpeechToTextProvider;
  deepgram?: DeepgramSpeechToTextConfig;
  nemotronMn?: NemotronMnSpeechToTextConfig;
  openai?: OpenAISpeechToTextConfig;
  whisperLocal?: WhisperLocalSpeechToTextConfig;
};

export type SpeechToTextAudioBuffer = Uint8Array | number[] | Record<string, number>;

export type SpeechToTextRequest = {
  audioBuffer: SpeechToTextAudioBuffer;
  fileName: string;
  languageHint?: string;
  mimeType: string;
};

export type SpeechToTextResult = {
  language?: string;
  model: string;
  provider: SpeechToTextProvider;
  text: string;
};
