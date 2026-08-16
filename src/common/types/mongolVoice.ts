/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-facing view types for the Mongolian voice core install surface
 * (`ipcBridge.mongolVoice`, docs/architecture/mongolian-voice.md).
 *
 * The source of truth for component ids, phases and per-component status is
 * the process-side provisioner (`services/voice/mongol`); everything here is
 * re-exported or derived from those types (type-only imports, erased at
 * build time) so this file cannot drift from what the provisioner emits.
 */

import type { MongolVoiceComponent } from '../../process/services/voice/mongol/manifest';
import type {
  MongolVoiceComponentStatus,
  MongolVoicePhase,
  MongolVoiceProgress,
} from '../../process/services/voice/mongol/MongolVoiceProvisioner';

export type { MongolVoiceComponent, MongolVoiceComponentStatus, MongolVoicePhase };

/** Live install progress frame, exactly as the provisioner emits it. */
export type MongolVoiceInstallProgress = MongolVoiceProgress;

/**
 * Every component id, exhaustively. Built from a `Record` keyed by the union
 * so a component added to the manifest fails compilation here instead of
 * silently missing from install loops and validators (the cookbook
 * VALID_BACKENDS lesson: a hand-written copy can quietly fall behind).
 */
const COMPONENT_IDS: Record<MongolVoiceComponent, true> = {
  'stt-runtime': true,
  'stt-model': true,
  'tts-bundle': true,
};

export const MONGOL_VOICE_COMPONENTS = Object.keys(COMPONENT_IDS) as readonly MongolVoiceComponent[];

/**
 * Aggregated status for the settings UI. `sttReady` / `ttsReady` are computed
 * main-side so every consumer applies the same definition: STT needs BOTH the
 * audio.cpp runtime and the Nemotron GGUF; TTS needs only the kitten bundle.
 */
export type MongolVoiceStatusView = {
  components: {
    sttRuntime: MongolVoiceComponentStatus;
    sttModel: MongolVoiceComponentStatus;
    ttsBundle: MongolVoiceComponentStatus;
  };
  sttReady: boolean;
  ttsReady: boolean;
};

/**
 * Result of one install request. Failures are returned, not thrown across
 * IPC, so the renderer gets a stable `errorCode` to translate instead of a
 * serialized stack trace (mirrors how cookbook downloads surface errors).
 */
export type MongolVoiceInstallResult = {
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
};
