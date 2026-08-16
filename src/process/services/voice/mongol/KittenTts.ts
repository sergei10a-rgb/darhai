/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HTTP client for the kitten-mn TTS server (docs/architecture/mongolian-voice.md).
 *
 * Speaks the `kitten-v1` bundle contract: `POST speakPath {text, voice?,
 * speed}` returns `audio/wav` bytes (413 when the text exceeds the bundle's
 * `max_chars`), and `GET healthPath` returns `{voices: [...], ...}`. The
 * server itself is owned by {@link kittenTtsServer}; this module only ensures
 * it is up before each request and restarts it ONCE when a request dies at the
 * socket level (the process can crash between the health check and the POST).
 */

import type { TextToSpeechAudio, TextToSpeechConfig } from '@/common/types/ttsTypes';
import {
  kittenTtsServer,
  KittenTtsUnavailableError,
  type KittenFetch,
  type KittenHttpResponse,
  type KittenTtsSession,
} from './KittenTtsServer';

export type KittenTtsRequestErrorCode = 'KITTEN_MN_TEXT_TOO_LONG' | 'KITTEN_MN_REQUEST_FAILED';

/**
 * Thrown when the server is up but a request fails. Carries a stable `code`
 * (also the message prefix) so the TTS bridge can surface a precise message -
 * notably TEXT_TOO_LONG, which the UI should fix by chunking, not by retrying.
 */
export class KittenTtsRequestError extends Error {
  readonly code: KittenTtsRequestErrorCode;

  constructor(code: KittenTtsRequestErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'KittenTtsRequestError';
    this.code = code;
  }
}

/** Injectable runtime seam. Production wires the singleton server + global fetch. */
export type KittenTtsRuntime = {
  server: {
    ensureRunning: () => Promise<KittenTtsSession>;
    stop: () => Promise<void>;
    /** True while a spawned server has passed readiness and not exited. */
    isRunning: () => boolean;
  };
  fetch: KittenFetch;
};

export const defaultKittenTtsRuntime: KittenTtsRuntime = {
  server: kittenTtsServer,
  fetch: (url, init) => fetch(url, init),
};

export type KittenTtsListVoicesOptions = {
  /**
   * When false, an already-running server is queried but a stopped one is NOT
   * started - the caller gets `[]` instead of a server process spawned as a
   * side effect of a read. Defaults to true (synthesize behaviour: bring the
   * server up on demand).
   */
  startIfNeeded?: boolean;
};

/**
 * Mongolian text-to-speech via the local kitten-mn server. No API key, no
 * network beyond loopback. Errors are typed, never silent empty audio.
 */
export class KittenTts {
  static async synthesize(
    text: string,
    config: TextToSpeechConfig,
    runtime: KittenTtsRuntime = defaultKittenTtsRuntime
  ): Promise<TextToSpeechAudio> {
    // `voice: 'default'` means "the bundle's own default": omit the field and
    // let the service decide, so a bundle update can rename its default voice
    // without breaking stored configs.
    const body = JSON.stringify({
      text,
      ...(config.voice !== 'default' ? { voice: config.voice } : {}),
      speed: config.speed,
    });

    const post = async (): Promise<KittenHttpResponse> => {
      const { baseUrl, manifest } = await runtime.server.ensureRunning();
      return runtime.fetch(`${baseUrl}${manifest.speakPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    };

    let res: KittenHttpResponse;
    try {
      res = await post();
    } catch (err) {
      // A typed availability error (not installed / bad bundle / start
      // timeout) will not be fixed by an immediate retry - propagate it.
      if (err instanceof KittenTtsUnavailableError) throw err;
      // Anything else is a socket-level failure: the server died under us.
      // Restart once and retry; a second failure propagates to the caller.
      await runtime.server.stop();
      res = await post();
    }

    if (res.status === 413) {
      throw new KittenTtsRequestError('KITTEN_MN_TEXT_TOO_LONG', 'text exceeds the bundle max_chars limit');
    }
    if (res.ok === false) {
      throw new KittenTtsRequestError('KITTEN_MN_REQUEST_FAILED', `speak request failed with HTTP ${res.status}`);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    return { data: bytes, mimeType: 'audio/wav' };
  }

  /** Voice ids the running bundle offers (`voices` from the status endpoint). */
  static async listVoices(
    runtime: KittenTtsRuntime = defaultKittenTtsRuntime,
    options?: KittenTtsListVoicesOptions
  ): Promise<string[]> {
    // A read-only surface (the settings voice picker) must not spawn a 575 MB
    // python process as a side effect of being looked at: with
    // `startIfNeeded: false` a stopped server simply means "no voices yet".
    if (options?.startIfNeeded === false && runtime.server.isRunning() === false) {
      return [];
    }
    const { baseUrl, manifest } = await runtime.server.ensureRunning();
    const res = await runtime.fetch(`${baseUrl}${manifest.healthPath}`);
    if (res.ok === false) {
      throw new KittenTtsRequestError('KITTEN_MN_REQUEST_FAILED', `status request failed with HTTP ${res.status}`);
    }
    const status: unknown = await res.json();
    if (status !== null && typeof status === 'object') {
      const voices = (status as Record<string, unknown>).voices;
      if (Array.isArray(voices)) {
        return voices.filter((v): v is string => typeof v === 'string');
      }
    }
    return [];
  }
}
