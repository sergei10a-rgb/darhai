/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-side view of the `tools.textToSpeech` config: one normalization
 * that layers a PLATFORM migration on top of the shared normalize (which the
 * main process also runs), plus a cached reader so surfaces that consult the
 * config often (every finished chat turn, every message row) do not each pay
 * an IPC round-trip.
 */

import { ConfigStorage } from '@/common/config/storage';
import type { TextToSpeechConfig } from '@/common/types/ttsTypes';
import { normalizeTextToSpeechConfig } from '@/common/types/ttsTypes';
import { isMacOS } from '@/renderer/utils/platform';

/** Fired (window-level) whenever a settings surface persists a new TTS config. */
export const TTS_CONFIG_CHANGED_EVENT = 'wayland:tts-config-changed';

/**
 * Shared normalize + the renderer's platform migration: `system-native` is
 * macOS `say` and returns silent empty audio everywhere else, so a stored
 * selection of it on a non-mac machine carries no workable intent - upgrade
 * it to kitten-mn (the only provider that actually speaks) instead of leaving
 * the user with a provider the UI does not even offer here. On macOS the
 * stored choice is kept as-is.
 */
export const normalizeRendererTextToSpeechConfig = (config?: Partial<TextToSpeechConfig>): TextToSpeechConfig => {
  const merged = normalizeTextToSpeechConfig(config);
  if (merged.provider === 'system-native' && isMacOS() === false) {
    return { ...merged, provider: 'kitten-mn' };
  }
  return merged;
};

let cachedConfig: Promise<TextToSpeechConfig> | null = null;

/** Drop the cached config so the next read hits storage again. */
export const invalidateTtsConfigCache = (): void => {
  cachedConfig = null;
};

if (typeof window !== 'undefined') {
  window.addEventListener(TTS_CONFIG_CHANGED_EVENT, invalidateTtsConfigCache);
}

/**
 * The current TTS config, normalized for this renderer. Cached until a
 * {@link TTS_CONFIG_CHANGED_EVENT} invalidates it, so per-message consumers
 * stay cheap. A storage failure degrades to defaults (TTS disabled) rather
 * than throwing into UI code, and is NOT cached - the next read retries.
 */
export const getTtsConfig = (): Promise<TextToSpeechConfig> => {
  if (cachedConfig === null) {
    cachedConfig = ConfigStorage.get('tools.textToSpeech').then(
      (stored) => normalizeRendererTextToSpeechConfig(stored ?? undefined),
      () => {
        invalidateTtsConfigCache();
        return normalizeRendererTextToSpeechConfig(undefined);
      }
    );
  }
  return cachedConfig;
};
