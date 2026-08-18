/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// Unit tests for mongolVoiceBridge - the IPC trust boundary of the Mongolian
// voice install surface. Covers:
//   - status aggregation: view keys + sttReady (runtime AND model) / ttsReady
//   - install: routes valid components to the provisioner; rejects unknown
//     component ids WITHOUT touching the provisioner; returns provisioner
//     error codes instead of throwing across IPC
//   - cancel: valid / unknown component
//   - ttsVoices: a failing voice list resolves to { voices: [] } (the empty
//     picker is the UI's normal not-installed state, never an IPC error)
//   - progress: provisioner 'progress' events reach the bridge emitter

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ----------------------------------------------------------------------------
// Mocks - capture the registered handlers so we can call them directly.
// vi.mock factories are hoisted above all imports, so they cannot reference
// top-level variables; stash the mock fns on globalThis (kickoffBridge's
// pattern) and read them back as locals below.
// ----------------------------------------------------------------------------

vi.mock('@/common', () => {
  const g = globalThis as Record<string, unknown>;
  const statusProvider = (g.__mnvStatusProvider ??= vi.fn()) as ReturnType<typeof vi.fn>;
  const installProvider = (g.__mnvInstallProvider ??= vi.fn()) as ReturnType<typeof vi.fn>;
  const cancelProvider = (g.__mnvCancelProvider ??= vi.fn()) as ReturnType<typeof vi.fn>;
  const voicesProvider = (g.__mnvVoicesProvider ??= vi.fn()) as ReturnType<typeof vi.fn>;
  const progressEmit = (g.__mnvProgressEmit ??= vi.fn()) as ReturnType<typeof vi.fn>;
  return {
    ipcBridge: {
      mongolVoice: {
        status: { provider: statusProvider },
        install: { provider: installProvider },
        cancel: { provider: cancelProvider },
        ttsVoices: { provider: voicesProvider },
        onProgress: { emit: progressEmit },
      },
    },
  };
});

// The production default for listVoices delegates to KittenTts.listVoices with
// startIfNeeded:false - mock the module so the test can assert that contract
// without touching a real server.
vi.mock('@process/services/voice/mongol/KittenTts', () => {
  const gk = globalThis as Record<string, unknown>;
  const listVoicesMock = (gk.__mnvKittenListVoices ??= vi.fn()) as ReturnType<typeof vi.fn>;
  return { KittenTts: { listVoices: listVoicesMock } };
});

const g = globalThis as Record<string, unknown>;
const kittenListVoicesMock = g.__mnvKittenListVoices as ReturnType<typeof vi.fn>;
const statusProviderMock = g.__mnvStatusProvider as ReturnType<typeof vi.fn>;
const installProviderMock = g.__mnvInstallProvider as ReturnType<typeof vi.fn>;
const cancelProviderMock = g.__mnvCancelProvider as ReturnType<typeof vi.fn>;
const voicesProviderMock = g.__mnvVoicesProvider as ReturnType<typeof vi.fn>;
const progressEmitMock = g.__mnvProgressEmit as ReturnType<typeof vi.fn>;

import {
  initMongolVoiceBridge,
  toStatusView,
  type MongolVoiceProvisionerLike,
} from '@process/bridge/media/voice/mongolVoiceBridge';
import type { MongolVoiceStatus } from '@process/services/voice/mongol/MongolVoiceProvisioner';
import type {
  MongolVoiceComponentStatus,
  MongolVoiceInstallProgress,
  MongolVoiceInstallResult,
  MongolVoiceStatusView,
} from '@/common/types/mongolVoice';

/** One component's status with overridable fields. */
function componentStatus(overrides: Partial<MongolVoiceComponentStatus> = {}): MongolVoiceComponentStatus {
  return { supported: true, pinned: true, installed: false, tag: 'test-tag', bytes: 1_000_000, ...overrides };
}

function fullStatus(installed: { runtime?: boolean; model?: boolean; bundle?: boolean }): MongolVoiceStatus {
  return {
    'stt-runtime': componentStatus({ installed: installed.runtime === true, tag: 'rt', bytes: 24_231_095 }),
    'stt-model': componentStatus({ installed: installed.model === true, tag: 'mdl', bytes: 931_233_056 }),
    'tts-bundle': componentStatus({ installed: installed.bundle === true, tag: 'tts', bytes: 726_089_788 }),
  };
}

/** A fake provisioner whose progress listeners the test can fire directly. */
function fakeProvisioner(status: MongolVoiceStatus): MongolVoiceProvisionerLike & {
  installMock: ReturnType<typeof vi.fn>;
  cancelMock: ReturnType<typeof vi.fn>;
  fireProgress: (p: MongolVoiceInstallProgress) => void;
} {
  const listeners: Array<(p: MongolVoiceInstallProgress) => void> = [];
  const installMock = vi.fn().mockResolvedValue(undefined);
  const cancelMock = vi.fn().mockReturnValue(true);
  return {
    status: () => status,
    install: installMock,
    cancel: cancelMock,
    on: (_event, listener) => {
      listeners.push(listener);
      return undefined;
    },
    installMock,
    cancelMock,
    fireProgress: (p) => {
      for (const listener of listeners) listener(p);
    },
  };
}

type StatusHandler = () => Promise<MongolVoiceStatusView>;
type InstallHandler = (req: { component: unknown }) => Promise<MongolVoiceInstallResult>;
type CancelHandler = (req: { component: unknown }) => Promise<{ cancelled: boolean }>;
type VoicesHandler = () => Promise<{ voices: string[] }>;

function lastHandler<T>(mock: ReturnType<typeof vi.fn>, name: string): T {
  const last = mock.mock.calls.at(-1);
  if (!last) throw new Error(`${name} provider was never registered`);
  return last[0] as T;
}

beforeEach(() => {
  kittenListVoicesMock.mockReset();
  statusProviderMock.mockReset();
  installProviderMock.mockReset();
  cancelProviderMock.mockReset();
  voicesProviderMock.mockReset();
  progressEmitMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('toStatusView', () => {
  it('maps kebab-cased components onto view keys and computes readiness', () => {
    const view = toStatusView(fullStatus({ runtime: true, model: true, bundle: false }));
    expect(view.components.sttRuntime.installed).toBe(true);
    expect(view.components.sttModel.installed).toBe(true);
    expect(view.components.ttsBundle.installed).toBe(false);
    expect(view.sttReady).toBe(true);
    expect(view.ttsReady).toBe(false);
  });

  it('sttReady requires BOTH the runtime and the model', () => {
    expect(toStatusView(fullStatus({ runtime: true, model: false })).sttReady).toBe(false);
    expect(toStatusView(fullStatus({ runtime: false, model: true })).sttReady).toBe(false);
  });

  it('ttsReady keys on the bundle alone', () => {
    const view = toStatusView(fullStatus({ bundle: true }));
    expect(view.ttsReady).toBe(true);
    expect(view.sttReady).toBe(false);
  });
});

describe('mongolVoiceBridge.status', () => {
  it('serves the aggregated view over IPC', async () => {
    const provisioner = fakeProvisioner(fullStatus({ runtime: true, model: true, bundle: true }));
    initMongolVoiceBridge({ provisioner: () => provisioner, listVoices: async () => [] });
    const handler = lastHandler<StatusHandler>(statusProviderMock, 'status');
    const view = await handler();
    expect(view.sttReady).toBe(true);
    expect(view.ttsReady).toBe(true);
    expect(view.components.sttModel.bytes).toBe(931_233_056);
  });
});

describe('mongolVoiceBridge.install', () => {
  it('routes a valid component to the provisioner and reports ok', async () => {
    const provisioner = fakeProvisioner(fullStatus({}));
    initMongolVoiceBridge({ provisioner: () => provisioner, listVoices: async () => [] });
    const handler = lastHandler<InstallHandler>(installProviderMock, 'install');
    const result = await handler({ component: 'tts-bundle' });
    expect(result).toEqual({ ok: true, errorCode: null, errorMessage: null });
    expect(provisioner.installMock).toHaveBeenCalledWith('tts-bundle');
  });

  it('rejects an unknown component without touching the provisioner', async () => {
    const provisioner = fakeProvisioner(fullStatus({}));
    initMongolVoiceBridge({ provisioner: () => provisioner, listVoices: async () => [] });
    const handler = lastHandler<InstallHandler>(installProviderMock, 'install');
    const result = await handler({ component: '../../etc/passwd' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('VOICE_UNKNOWN_COMPONENT');
    expect(provisioner.installMock).not.toHaveBeenCalled();
  });

  it('returns the provisioner error code instead of throwing across IPC', async () => {
    const provisioner = fakeProvisioner(fullStatus({}));
    const failure = Object.assign(new Error('VOICE_HASH_MISMATCH: digest differs'), {
      code: 'VOICE_HASH_MISMATCH',
    });
    provisioner.installMock.mockRejectedValueOnce(failure);
    initMongolVoiceBridge({ provisioner: () => provisioner, listVoices: async () => [] });
    const handler = lastHandler<InstallHandler>(installProviderMock, 'install');
    const result = await handler({ component: 'stt-model' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('VOICE_HASH_MISMATCH');
    expect(result.errorMessage).toContain('digest differs');
  });
});

describe('mongolVoiceBridge.cancel', () => {
  it('cancels a valid component through the provisioner', async () => {
    const provisioner = fakeProvisioner(fullStatus({}));
    initMongolVoiceBridge({ provisioner: () => provisioner, listVoices: async () => [] });
    const handler = lastHandler<CancelHandler>(cancelProviderMock, 'cancel');
    await expect(handler({ component: 'stt-runtime' })).resolves.toEqual({ cancelled: true });
    expect(provisioner.cancelMock).toHaveBeenCalledWith('stt-runtime');
  });

  it('answers { cancelled: false } for an unknown component', async () => {
    const provisioner = fakeProvisioner(fullStatus({}));
    initMongolVoiceBridge({ provisioner: () => provisioner, listVoices: async () => [] });
    const handler = lastHandler<CancelHandler>(cancelProviderMock, 'cancel');
    await expect(handler({ component: 42 })).resolves.toEqual({ cancelled: false });
    expect(provisioner.cancelMock).not.toHaveBeenCalled();
  });
});

describe('mongolVoiceBridge.ttsVoices', () => {
  it('returns the bundle voices', async () => {
    const provisioner = fakeProvisioner(fullStatus({ bundle: true }));
    const voices = [
      { name: 'garav', label: 'Гарав' },
      { name: 'nomin', label: 'Номин' },
    ];
    initMongolVoiceBridge({ provisioner: () => provisioner, listVoices: async () => voices });
    const handler = lastHandler<VoicesHandler>(voicesProviderMock, 'ttsVoices');
    await expect(handler()).resolves.toEqual({ voices });
  });

  it('resolves { voices: [] } when the voice list throws (not installed is a normal state)', async () => {
    const provisioner = fakeProvisioner(fullStatus({}));
    initMongolVoiceBridge({
      provisioner: () => provisioner,
      listVoices: async () => {
        throw new Error('KITTEN_MN_NOT_INSTALLED: TTS bundle is not installed');
      },
    });
    const handler = lastHandler<VoicesHandler>(voicesProviderMock, 'ttsVoices');
    await expect(handler()).resolves.toEqual({ voices: [] });
  });

  it('production default queries KittenTts with startIfNeeded:false (a stopped server is never spawned)', async () => {
    // No listVoices injected: the bridge's own default must be exercised.
    kittenListVoicesMock.mockResolvedValueOnce([]);
    const provisioner = fakeProvisioner(fullStatus({}));
    initMongolVoiceBridge({ provisioner: () => provisioner });
    const handler = lastHandler<VoicesHandler>(voicesProviderMock, 'ttsVoices');
    await expect(handler()).resolves.toEqual({ voices: [] });
    expect(kittenListVoicesMock).toHaveBeenCalledTimes(1);
    expect(kittenListVoicesMock).toHaveBeenCalledWith(undefined, { startIfNeeded: false });
  });
});

describe('mongolVoiceBridge progress forwarding', () => {
  it('forwards provisioner progress frames to the renderer emitter', () => {
    const provisioner = fakeProvisioner(fullStatus({}));
    initMongolVoiceBridge({ provisioner: () => provisioner, listVoices: async () => [] });
    const frame: MongolVoiceInstallProgress = {
      component: 'stt-model',
      phase: 'download',
      bytesDone: 12_345,
      bytesTotal: 931_233_056,
    };
    provisioner.fireProgress(frame);
    expect(progressEmitMock).toHaveBeenCalledWith(frame);
  });
});
