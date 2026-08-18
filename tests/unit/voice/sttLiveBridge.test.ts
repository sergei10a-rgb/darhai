/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * sttLiveBridge tests - the IPC trust boundary of live dictation. The live
 * session manager is a fake; what is asserted is the wire contract the
 * renderer depends on:
 *   - start wires the manager's onDelta into the sttLive.on-delta emitter
 *     (payload { text } carrying the FULL partial)
 *   - chunk coerces number[] AND index-keyed IPC payloads into Uint8Array
 *   - stop resolves { text } from the manager
 *   - cancel delegates to the manager
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above imports; stash mocks on globalThis
// (mongolVoiceBridge.test.ts's pattern) and read them back as locals below.
vi.mock('@/common', () => {
  const g = globalThis as Record<string, unknown>;
  const startProvider = (g.__sttLiveStartProvider ??= vi.fn()) as ReturnType<typeof vi.fn>;
  const chunkProvider = (g.__sttLiveChunkProvider ??= vi.fn()) as ReturnType<typeof vi.fn>;
  const stopProvider = (g.__sttLiveStopProvider ??= vi.fn()) as ReturnType<typeof vi.fn>;
  const cancelProvider = (g.__sttLiveCancelProvider ??= vi.fn()) as ReturnType<typeof vi.fn>;
  const deltaEmit = (g.__sttLiveDeltaEmit ??= vi.fn()) as ReturnType<typeof vi.fn>;
  return {
    ipcBridge: {
      sttLive: {
        start: { provider: startProvider },
        chunk: { provider: chunkProvider },
        stop: { provider: stopProvider },
        cancel: { provider: cancelProvider },
        onDelta: { emit: deltaEmit },
      },
    },
  };
});

const g = globalThis as Record<string, unknown>;
const startProviderMock = g.__sttLiveStartProvider as ReturnType<typeof vi.fn>;
const chunkProviderMock = g.__sttLiveChunkProvider as ReturnType<typeof vi.fn>;
const stopProviderMock = g.__sttLiveStopProvider as ReturnType<typeof vi.fn>;
const cancelProviderMock = g.__sttLiveCancelProvider as ReturnType<typeof vi.fn>;
const deltaEmitMock = g.__sttLiveDeltaEmit as ReturnType<typeof vi.fn>;

import { initSttLiveBridge, type SttLiveManagerLike } from '@process/bridge/media/voice/sttLiveBridge';

type StartHandler = (params: void) => Promise<void>;
type ChunkHandler = (params: { data: unknown }) => Promise<void>;
type StopHandler = (params: void) => Promise<{ text: string }>;
type CancelHandler = (params: void) => Promise<void>;

function lastHandler<T>(mock: ReturnType<typeof vi.fn>, name: string): T {
  const last = mock.mock.calls.at(-1);
  if (!last) throw new Error(`${name} provider was never registered`);
  return last[0] as T;
}

type FakeLive = SttLiveManagerLike & {
  startMock: ReturnType<typeof vi.fn>;
  pushed: Uint8Array[];
  stopMock: ReturnType<typeof vi.fn>;
  cancelMock: ReturnType<typeof vi.fn>;
  fireDelta: (text: string) => void;
};

function fakeLive(): FakeLive {
  let onDelta: ((text: string) => void) | undefined;
  const pushed: Uint8Array[] = [];
  const startMock = vi.fn(async (events?: { onDelta?: (text: string) => void }) => {
    onDelta = events?.onDelta;
  });
  const stopMock = vi.fn(async () => 'эцсийн текст');
  const cancelMock = vi.fn();
  return {
    start: startMock,
    pushChunk: (pcm: Uint8Array) => {
      pushed.push(pcm);
    },
    stop: stopMock,
    cancel: cancelMock,
    startMock,
    pushed,
    stopMock,
    cancelMock,
    fireDelta: (text) => onDelta?.(text),
  };
}

beforeEach(() => {
  startProviderMock.mockReset();
  chunkProviderMock.mockReset();
  stopProviderMock.mockReset();
  cancelProviderMock.mockReset();
  deltaEmitMock.mockReset();
});

describe('sttLiveBridge.start', () => {
  it('starts a session and forwards its deltas to the on-delta emitter as { text }', async () => {
    const live = fakeLive();
    initSttLiveBridge({ live: () => live });
    const handler = lastHandler<StartHandler>(startProviderMock, 'start');
    await handler(undefined as void);

    expect(live.startMock).toHaveBeenCalledTimes(1);
    live.fireDelta('сайн');
    live.fireDelta('сайн байна');
    expect(deltaEmitMock.mock.calls.map((c) => c[0])).toEqual([{ text: 'сайн' }, { text: 'сайн байна' }]);
  });
});

describe('sttLiveBridge.chunk', () => {
  it('coerces a number[] payload into Uint8Array', async () => {
    const live = fakeLive();
    initSttLiveBridge({ live: () => live });
    const handler = lastHandler<ChunkHandler>(chunkProviderMock, 'chunk');
    await handler({ data: [1, 2, 255] });

    expect(live.pushed).toHaveLength(1);
    expect(live.pushed[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(live.pushed[0])).toEqual([1, 2, 255]);
  });

  it('coerces an index-keyed IPC payload into Uint8Array', async () => {
    const live = fakeLive();
    initSttLiveBridge({ live: () => live });
    const handler = lastHandler<ChunkHandler>(chunkProviderMock, 'chunk');
    await handler({ data: { 0: 7, 1: 9, 2: 11 } });

    expect(Array.from(live.pushed[0])).toEqual([7, 9, 11]);
  });

  it('ignores an empty or malformed payload without touching the session', async () => {
    const live = fakeLive();
    initSttLiveBridge({ live: () => live });
    const handler = lastHandler<ChunkHandler>(chunkProviderMock, 'chunk');
    await handler({ data: undefined });
    await handler({ data: 'not-audio' });

    expect(live.pushed).toHaveLength(0);
  });
});

describe('sttLiveBridge.stop', () => {
  it('resolves { text } with the final transcript from the manager', async () => {
    const live = fakeLive();
    initSttLiveBridge({ live: () => live });
    const handler = lastHandler<StopHandler>(stopProviderMock, 'stop');
    await expect(handler(undefined as void)).resolves.toEqual({ text: 'эцсийн текст' });
    expect(live.stopMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a typed stop failure to the caller (bridge error path)', async () => {
    const live = fakeLive();
    live.stopMock.mockRejectedValueOnce(new Error('NEMOTRON_MN_LIVE_NOT_ACTIVE: no live dictation session is active'));
    initSttLiveBridge({ live: () => live });
    const handler = lastHandler<StopHandler>(stopProviderMock, 'stop');
    await expect(handler(undefined as void)).rejects.toThrow(/^NEMOTRON_MN_LIVE_NOT_ACTIVE/);
  });
});

describe('sttLiveBridge.cancel', () => {
  it('delegates to the manager', async () => {
    const live = fakeLive();
    initSttLiveBridge({ live: () => live });
    const handler = lastHandler<CancelHandler>(cancelProviderMock, 'cancel');
    await handler(undefined as void);
    expect(live.cancelMock).toHaveBeenCalledTimes(1);
  });
});
