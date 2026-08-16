/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the Mongolian voice core (`ipcBridge.mongolVoice`,
 * docs/architecture/mongolian-voice.md): component install status, install /
 * cancel with live progress frames, and the kitten-mn voice list.
 *
 * SECURITY - LOCAL RENDERER ONLY. The whole `mongolVoice.` namespace is
 * remote-denied in bridgeAllowlist REMOTE_DENIED_PREFIXES: `install` downloads
 * archives that put executable code on disk and the voice servers then run it,
 * the same install+exec class as `cookbook.` / `llamaRuntime.`. The local
 * renderer contract is still untrusted input crossing a process boundary, so
 * the component id is validated here (mirroring cookbookBridge's safeBackend)
 * before it reaches the provisioner.
 *
 * Progress reaches the renderer the same way cookbook download progress does:
 * the provisioner's `progress` events are forwarded through a bridge emitter
 * (`mongolVoice.on-progress`), and the renderer hook subscribes with `.on()`.
 *
 * Install failures are RETURNED as `{ ok: false, errorCode }` rather than
 * thrown across IPC, so the UI gets the provisioner's stable code
 * (VOICE_HASH_MISMATCH, VOICE_CANCELLED, ...) instead of a serialized stack.
 */

import { ipcBridge } from '@/common';
import { getPlatformServices } from '@/common/platform';
import { MONGOL_VOICE_COMPONENTS } from '@/common/types/mongolVoice';
import type {
  KittenVoiceOption,
  MongolVoiceComponent,
  MongolVoiceInstallProgress,
  MongolVoiceInstallResult,
  MongolVoiceStatusView,
} from '@/common/types/mongolVoice';
import { MongolVoiceProvisioner, type MongolVoiceStatus } from '@process/services/voice/mongol/MongolVoiceProvisioner';
import { KittenTts } from '@process/services/voice/mongol/KittenTts';

/** Returned when the renderer names a component the manifest does not know. */
const UNKNOWN_COMPONENT_CODE = 'VOICE_UNKNOWN_COMPONENT';

/** Fallback code when a thrown value carries no `code` of its own. */
const UNKNOWN_ERROR_CODE = 'VOICE_UNKNOWN';

/** The provisioner surface this bridge drives (structural, so tests can fake it). */
export type MongolVoiceProvisionerLike = {
  status: () => MongolVoiceStatus;
  install: (component: MongolVoiceComponent) => Promise<void>;
  cancel: (component: MongolVoiceComponent) => boolean;
  on: (event: 'progress', listener: (p: MongolVoiceInstallProgress) => void) => unknown;
};

/** Injectable collaborators - production defaults are wired in {@link initMongolVoiceBridge}. */
export type MongolVoiceBridgeDeps = {
  provisioner: () => MongolVoiceProvisionerLike;
  /**
   * Voice ids from the RUNNING kitten-mn bundle. NEVER starts the TTS server:
   * the production default passes `startIfNeeded: false`, so merely opening
   * the Voice settings page cannot spawn the bundle's python process. A
   * stopped server yields `[]` - the first speak is what starts it.
   */
  listVoices: () => Promise<KittenVoiceOption[]>;
  /** Push one progress frame to the renderer. */
  emitProgress: (p: MongolVoiceInstallProgress) => void;
};

const VALID_COMPONENTS: ReadonlySet<MongolVoiceComponent> = new Set(MONGOL_VOICE_COMPONENTS);

/** Narrow an untrusted component id to a known value, else null. */
function safeComponent(value: unknown): MongolVoiceComponent | null {
  return typeof value === 'string' && VALID_COMPONENTS.has(value as MongolVoiceComponent)
    ? (value as MongolVoiceComponent)
    : null;
}

/** The `code` a MongolVoiceProvisionError carries, else the fallback. */
function errorCodeOf(err: unknown): string {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.length > 0 ? code : UNKNOWN_ERROR_CODE;
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map the provisioner's kebab-keyed status onto the renderer view, computing
 * readiness ONCE here so every consumer applies the same definition: STT needs
 * both the audio.cpp runtime AND the Nemotron GGUF; TTS needs only the bundle.
 */
export function toStatusView(status: MongolVoiceStatus): MongolVoiceStatusView {
  const sttRuntime = status['stt-runtime'];
  const sttModel = status['stt-model'];
  const ttsBundle = status['tts-bundle'];
  return {
    components: { sttRuntime, sttModel, ttsBundle },
    sttReady: sttRuntime.installed === true && sttModel.installed === true,
    ttsReady: ttsBundle.installed === true,
  };
}

/**
 * One provisioner per Darhai process, created on first use. Its `cancel()`
 * keys on in-flight AbortControllers, so every verb must talk to the SAME
 * instance - a fresh provisioner per call would make cancel a no-op.
 */
let sharedProvisioner: MongolVoiceProvisioner | null = null;

function productionProvisioner(): MongolVoiceProvisionerLike {
  if (sharedProvisioner === null) {
    sharedProvisioner = new MongolVoiceProvisioner(getPlatformServices().paths.getDataDir());
  }
  return sharedProvisioner;
}

/** Initialize the Mongolian voice IPC bridge handlers. */
export function initMongolVoiceBridge(deps?: Partial<MongolVoiceBridgeDeps>): void {
  const resolved: MongolVoiceBridgeDeps = {
    provisioner: productionProvisioner,
    // `startIfNeeded: false`: listing voices is a read, not a reason to spawn
    // the TTS server (it used to keep a ~575 MB python process alive until app
    // quit just because the settings page was opened).
    listVoices: () => KittenTts.listVoices(undefined, { startIfNeeded: false }),
    emitProgress: (p) => ipcBridge.mongolVoice.onProgress.emit(p),
    ...deps,
  };
  const provisioner = resolved.provisioner();
  // Forward provisioner progress to the renderer (cookbook's onDownloadProgress
  // pattern). initAllBridges runs once per process, so this wires one listener.
  provisioner.on('progress', (p) => resolved.emitProgress(p));

  ipcBridge.mongolVoice.status.provider(async (): Promise<MongolVoiceStatusView> => {
    return toStatusView(provisioner.status());
  });

  ipcBridge.mongolVoice.install.provider(async ({ component }): Promise<MongolVoiceInstallResult> => {
    const id = safeComponent(component);
    if (id === null) {
      return {
        ok: false,
        errorCode: UNKNOWN_COMPONENT_CODE,
        errorMessage: `unknown component ${JSON.stringify(component).slice(0, 64)}`,
      };
    }
    try {
      await provisioner.install(id);
      return { ok: true, errorCode: null, errorMessage: null };
    } catch (err) {
      return { ok: false, errorCode: errorCodeOf(err), errorMessage: errorMessageOf(err) };
    }
  });

  ipcBridge.mongolVoice.cancel.provider(async ({ component }): Promise<{ cancelled: boolean }> => {
    const id = safeComponent(component);
    if (id === null) return { cancelled: false };
    return { cancelled: provisioner.cancel(id) };
  });

  ipcBridge.mongolVoice.ttsVoices.provider(async (): Promise<{ voices: KittenVoiceOption[] }> => {
    try {
      return { voices: await resolved.listVoices() };
    } catch {
      // Not installed / failed to start is a NORMAL state for this surface:
      // the voice picker simply has nothing to offer yet. The install card is
      // where that condition is diagnosed and fixed, not here.
      return { voices: [] };
    }
  });
}
