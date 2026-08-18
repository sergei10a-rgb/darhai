/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for live Mongolian dictation (`ipcBridge.sttLive`,
 * docs/architecture/mongolian-voice.md): start / chunk / stop / cancel verbs
 * over the NemotronLive session manager, with partial text streamed back
 * through the `sttLive.on-delta` emitter (the mongolVoice.onProgress pattern).
 *
 * Delta payloads carry the FULL accumulated partial (`{ text }`): the deltas
 * are merged exactly once, in main, so the renderer only ever REPLACES its
 * display - it never has to reason about append-vs-replace.
 *
 * Errors REJECT across the bridge (withBridgeErrorPropagation) with messages
 * that start with a stable code (NEMOTRON_MN_NOT_INSTALLED /
 * NEMOTRON_MN_START_* / NEMOTRON_MN_LIVE_*), the same convention as
 * speechToText.transcribe. Chunk payloads are untrusted renderer input
 * crossing a process boundary: they are coerced to bytes here and anything
 * malformed is dropped without reaching the session.
 */

import { ipcBridge } from '@/common';
import { nemotronLive } from '@process/services/voice/mongol/NemotronLive';

/** The manager surface this bridge drives (structural, so tests can fake it). */
export type SttLiveManagerLike = {
  start: (events?: { onDelta?: (text: string) => void }) => Promise<void>;
  pushChunk: (pcm: Uint8Array) => void;
  stop: () => Promise<string>;
  cancel: () => void;
};

/** Injectable collaborators - production defaults are wired in {@link initSttLiveBridge}. */
export type SttLiveBridgeDeps = {
  live: () => SttLiveManagerLike;
  /** Push one partial-text frame to the renderer. */
  emitDelta: (payload: { text: string }) => void;
};

/**
 * IPC audio payloads arrive as number[] (the declared type), Uint8Array, or
 * index-keyed objects after serialization (the same reality NemotronStt's
 * toBuffer handles). Anything else coerces to empty and is dropped.
 */
function toPcm(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (data !== null && typeof data === 'object') {
    const record = data as Record<string, number>;
    const ordered = Object.keys(record)
      .filter((key) => /^\d+$/.test(key))
      .toSorted((a, b) => Number(a) - Number(b))
      .map((key) => record[key] ?? 0);
    return Uint8Array.from(ordered);
  }
  return new Uint8Array(0);
}

/** Initialize the live-dictation IPC bridge handlers. */
export function initSttLiveBridge(deps?: Partial<SttLiveBridgeDeps>): void {
  const resolved: SttLiveBridgeDeps = {
    live: () => nemotronLive,
    emitDelta: (payload) => ipcBridge.sttLive.onDelta.emit(payload),
    ...deps,
  };

  ipcBridge.sttLive.start.provider(async () => {
    await resolved.live().start({ onDelta: (text) => resolved.emitDelta({ text }) });
  });

  ipcBridge.sttLive.chunk.provider(async (params) => {
    const pcm = toPcm(params?.data);
    if (pcm.length === 0) return;
    resolved.live().pushChunk(pcm);
  });

  ipcBridge.sttLive.stop.provider(async () => {
    return { text: await resolved.live().stop() };
  });

  ipcBridge.sttLive.cancel.provider(async () => {
    resolved.live().cancel();
  });
}
