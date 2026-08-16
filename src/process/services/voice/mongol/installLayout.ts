/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * On-disk layout and receipts for the Mongolian voice core.
 *
 * Mirrors the llama.cpp provisioner's discipline (`services/llamacpp/
 * installLayout.ts`): a component version is "installed" only when a receipt
 * written AFTER extraction parses at the current schema AND every file it
 * lists is still present. A directory without a receipt is an interrupted
 * install and gets cleaned up by the next attempt; a receipt listing files
 * that are gone reads as not installed rather than as a smaller-but-fine tree.
 *
 * Layout under `<userData>/voice/mongol/`:
 *
 *   downloads/               archives + `.part` resumable partials
 *   staging/                 extraction scratch, renamed into place on success
 *   stt/versions/<tag>/      extracted audio.cpp runtime + receipt
 *   stt/models/              model payloads (single files, e.g. the GGUF)
 *   tts/versions/<tag>/      extracted kitten bundle + receipt
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MongolVoiceComponent } from './manifest';

/** Receipt filename. Not dot-prefixed so it shows up in a listing. */
export const VOICE_RECEIPT_NAME = 'darhai-voice.json';

/** Bump when the receipt shape changes; an unknown schema reads as NOT installed. */
export const VOICE_RECEIPT_SCHEMA = 1;

export type MongolVoiceReceipt = {
  schema: number;
  component: MongolVoiceComponent;
  tag: string;
  platform: string;
  arch: string;
  /** The archive as verified before extraction. */
  asset: { url: string; sha256: string; bytes: number };
  /**
   * Every file the extraction produced, install-dir-relative with `/`
   * separators, excluding the receipt, sorted. A list rather than a count so a
   * later check can say WHICH file is gone.
   */
  files: string[];
  /** Install-dir-relative path readiness keys on (server exe / bundle entry). */
  entryRelPath: string;
  installedAt: string;
};

/** Sync filesystem seam, so readiness can be unit-tested without touching disk. */
export type VoiceFsProbe = {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
};

export const defaultVoiceFsProbe: VoiceFsProbe = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p, 'utf8'),
};

/** Root of every managed Mongolian-voice artefact. */
export function mongolVoiceRoot(userDataDir: string): string {
  return path.join(userDataDir, 'voice', 'mongol');
}

/** Partial and completed archive downloads. Never executed from. */
export function voiceDownloadsDir(userDataDir: string): string {
  return path.join(mongolVoiceRoot(userDataDir), 'downloads');
}

/** Extraction scratch space. Never executed from. */
export function voiceStagingDir(userDataDir: string): string {
  return path.join(mongolVoiceRoot(userDataDir), 'staging');
}

const COMPONENT_SUBDIR: Record<MongolVoiceComponent, string> = {
  'stt-runtime': 'stt',
  'stt-model': 'stt',
  'tts-bundle': 'tts',
};

/** Directory holding completed installs of one component, one per tag. */
export function componentVersionsDir(userDataDir: string, component: MongolVoiceComponent): string {
  return path.join(mongolVoiceRoot(userDataDir), COMPONENT_SUBDIR[component], 'versions');
}

/** Completed install directory for one component version. */
export function componentInstallDir(userDataDir: string, component: MongolVoiceComponent, tag: string): string {
  return path.join(componentVersionsDir(userDataDir, component), tag);
}

/** Directory for single-file model payloads (the STT GGUF). */
export function sttModelsDir(userDataDir: string): string {
  return path.join(mongolVoiceRoot(userDataDir), 'stt', 'models');
}

/** Absolute path of a single-file STT model payload. */
export function sttModelPath(userDataDir: string, filename: string): string {
  return path.join(sttModelsDir(userDataDir), filename);
}

/** Absolute path of a component version's receipt. */
export function voiceReceiptPath(userDataDir: string, component: MongolVoiceComponent, tag: string): string {
  return path.join(componentInstallDir(userDataDir, component, tag), VOICE_RECEIPT_NAME);
}

/** True for an array whose every element is a non-empty string. */
function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}

/** Shape-check a parsed receipt without trusting any field. */
function isReceipt(value: unknown): value is MongolVoiceReceipt {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    r.schema === VOICE_RECEIPT_SCHEMA &&
    (r.component === 'stt-runtime' || r.component === 'stt-model' || r.component === 'tts-bundle') &&
    typeof r.tag === 'string' &&
    r.tag.length > 0 &&
    typeof r.entryRelPath === 'string' &&
    r.entryRelPath.length > 0 &&
    isStringList(r.files) &&
    r.files.length > 0
  );
}

/**
 * Read a component version's receipt, or null when it is absent, unparseable,
 * of an unknown schema, or describes a different component/tag than the
 * directory it sits in (a moved or hand-edited tree is not an install).
 */
export function readVoiceReceipt(
  userDataDir: string,
  component: MongolVoiceComponent,
  tag: string,
  probe: VoiceFsProbe = defaultVoiceFsProbe
): MongolVoiceReceipt | null {
  const file = voiceReceiptPath(userDataDir, component, tag);
  if (!probe.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(probe.readFileSync(file));
  } catch {
    return null;
  }
  if (!isReceipt(parsed)) return null;
  if (parsed.tag !== tag || parsed.component !== component) return null;
  return parsed;
}

/**
 * True when a component version is installed and complete: its receipt parses
 * and every file the receipt lists - including the entry - is still present.
 */
export function isVoiceComponentInstalled(
  userDataDir: string,
  component: MongolVoiceComponent,
  tag: string,
  probe: VoiceFsProbe = defaultVoiceFsProbe
): boolean {
  const receipt = readVoiceReceipt(userDataDir, component, tag, probe);
  if (!receipt) return false;
  const dir = componentInstallDir(userDataDir, component, tag);
  if (!probe.existsSync(path.join(dir, receipt.entryRelPath))) return false;
  for (const rel of receipt.files) {
    if (!probe.existsSync(path.join(dir, rel))) return false;
  }
  return true;
}

/**
 * True when the single-file STT model is present at its full pinned size.
 *
 * Single files get no receipt: the atomic `.part` → final rename means a file
 * at the final path was fully downloaded and hash-verified. The size check
 * still catches a truncated file placed there by something else.
 */
export function isSttModelInstalled(
  userDataDir: string,
  filename: string,
  expectedBytes: number,
  statSize: (p: string) => number | null = (p) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return null;
    }
  }
): boolean {
  const size = statSize(sttModelPath(userDataDir, filename));
  return size !== null && size === expectedBytes;
}
