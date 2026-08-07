/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * New API gateway platform identifier
 */
export const NEW_API_PLATFORM_ID = 'new-api';

/**
 * Placeholder credential for keyless LOCAL backends (Ollama / LM Studio /
 * llama.cpp), which accept no API key. Both the OpenAI SDK constructor and the
 * bundled wcore engine's key resolution reject an empty key outright, so this
 * harmless non-secret token is injected ONLY when the resolved base URL host is
 * local (see `isLocalBaseUrl`). It is never persisted as a real credential and
 * never sent to a non-local host - cloud providers still hard-require a real key.
 */
export const LOCAL_KEYLESS_PLACEHOLDER = 'ollama';

/**
 * Check if platform is New API gateway type
 */
export const isNewApiPlatform = (platform: string): boolean => {
  return platform === NEW_API_PLATFORM_ID;
};
