/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * On-disk layout of managed llama.cpp installs, and the receipt that makes
 * "is llama.cpp ready?" a filesystem fact rather than a guess.
 *
 *   <userData>/llamacpp/
 *     versions/
 *       b10437/                       <- a complete install, and only ever complete
 *         llama-server.exe
 *         ggml-cuda.dll
 *         ...
 *         darhai-llamacpp.json        <- the receipt, written LAST
 *     downloads/
 *       llama-b10437-bin-win-cuda-13.3-x64.zip.part   <- resumable, never read as installed
 *     staging/
 *       <tag>-<random>/               <- extraction target, renamed into versions/ on success
 *
 * `downloads/` and `staging/` are working space, not archives: a verified
 * archive is deleted once it is installed, a failed attempt takes its staging
 * tree with it, and a later install sweeps whatever an outright kill left
 * behind. Both are owned by `LlamaCppProvisioner`.
 *
 * Two properties this layout buys:
 *
 *   - **A killed install can never look installed.** Extraction happens in
 *     `staging/`, the receipt is the last file written there, and the directory
 *     is then renamed into `versions/<tag>`. A process killed at any point
 *     leaves either nothing under `versions/`, or a directory that has already
 *     passed the receipt write. `staging/` and `downloads/` are outside the
 *     search path entirely, so a half-extracted tree is not merely incomplete -
 *     it is invisible.
 *   - **An upgrade cannot damage a working install.** `versions/` is keyed by
 *     release tag, so fetching b10500 writes a sibling directory; b10437 keeps
 *     running until something chooses otherwise.
 *
 * Readiness is checked with sync fs because `LocalServeManager`'s
 * `llamaServerCandidates` dep is `() => string[]`.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { HwfitBackend } from '@/common/types/hwfit';
import type { LlamaAcceleration, LlamaBackendFallback } from './assetMap';

/** Receipt filename. Deliberately not dot-prefixed so it shows up in a listing. */
export const RECEIPT_NAME = 'darhai-llamacpp.json';

/**
 * Bump when the receipt shape changes; an unknown schema reads as NOT ready.
 *
 * 2: replaced `fileCount` with the explicit `files` and `requires` lists. A
 * schema-1 receipt was written by an extractor that silently dropped every
 * symlink on macOS and Linux, and its `fileCount` was derived from that same
 * extractor - so it certified those installs as complete. Refusing to read it
 * makes the next serve reinstall rather than re-certify a broken tree.
 */
export const RECEIPT_SCHEMA = 2;

/** One verified archive that contributed to an install. */
export type LlamaInstalledAsset = {
  name: string;
  /** Hex sha256 of the archive as it landed on disk, checked before extraction. */
  sha256: string;
  bytes: number;
};

export type LlamaInstallReceipt = {
  schema: number;
  tag: string;
  platform: string;
  arch: string;
  requestedBackend: HwfitBackend;
  acceleration: LlamaAcceleration;
  fallback: LlamaBackendFallback | null;
  /** Install-dir-relative path of the server binary, e.g. `llama-server.exe`. */
  serverRelPath: string;
  assets: LlamaInstalledAsset[];
  /**
   * Every file the extraction produced, excluding the receipt, sorted.
   *
   * A list rather than a count, because a count can only catch a tree that got
   * smaller - it cannot catch a tree that was never complete, and it cannot say
   * which file is gone.
   */
  files: string[];
  /**
   * Library names the installed binaries name in their OWN link metadata.
   *
   * This is the one field not produced by the extractor (see `binaryDeps.ts`).
   * It is what lets readiness fail on an install that the extractor believed it
   * finished: `libggml-base.so.0` is here because `libggml-base.so.0.20.0` says
   * so, not because anything we wrote said so.
   */
  requires: string[];
  installedAt: string;
};

/** Sync filesystem seam, so readiness can be unit-tested without touching disk. */
export type LlamaFsProbe = {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  readdirSync: (p: string) => string[];
};

export const defaultLlamaFsProbe: LlamaFsProbe = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p, 'utf8'),
  readdirSync: (p) => fs.readdirSync(p),
};

/** Root of every managed llama.cpp artefact. */
export function llamaRoot(userDataDir: string): string {
  return path.join(userDataDir, 'llamacpp');
}

/** Directory holding completed installs, one per release tag. */
export function versionsDir(userDataDir: string): string {
  return path.join(llamaRoot(userDataDir), 'versions');
}

/** Completed install directory for one release tag. */
export function installDir(userDataDir: string, tag: string): string {
  return path.join(versionsDir(userDataDir), tag);
}

/** Partial and completed archive downloads. Never on the search path. */
export function downloadsDir(userDataDir: string): string {
  return path.join(llamaRoot(userDataDir), 'downloads');
}

/** Extraction scratch space. Never on the search path. */
export function stagingDir(userDataDir: string): string {
  return path.join(llamaRoot(userDataDir), 'staging');
}

/** Absolute path of a tag's receipt. */
export function receiptPath(userDataDir: string, tag: string): string {
  return path.join(installDir(userDataDir, tag), RECEIPT_NAME);
}

/** True for an array whose every element is a non-empty string. */
function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}

/** Shape-check a parsed receipt without trusting any field. */
function isReceipt(value: unknown): value is LlamaInstallReceipt {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    r.schema === RECEIPT_SCHEMA &&
    typeof r.tag === 'string' &&
    r.tag.length > 0 &&
    typeof r.serverRelPath === 'string' &&
    r.serverRelPath.length > 0 &&
    isStringList(r.files) &&
    r.files.length > 0 &&
    isStringList(r.requires) &&
    Array.isArray(r.assets)
  );
}

/**
 * Read a tag's receipt, or null when it is absent, unparseable, of an unknown
 * schema, or describes a different tag than the directory it sits in.
 */
export function readReceipt(
  userDataDir: string,
  tag: string,
  probe: LlamaFsProbe = defaultLlamaFsProbe
): LlamaInstallReceipt | null {
  const file = receiptPath(userDataDir, tag);
  if (!probe.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(probe.readFileSync(file));
  } catch {
    return null;
  }
  if (!isReceipt(parsed)) return null;
  // A receipt claiming a different tag than its directory means someone moved
  // or hand-edited the tree; refuse to treat it as an install of `tag`.
  if (parsed.tag !== tag) return null;
  return parsed;
}

/**
 * True when a tag is installed and runnable.
 *
 * Three facts must agree, and one of them does not come from us:
 *
 *   1. The receipt parses at the current schema and names this tag.
 *   2. Every file it lists is still there - which catches a tree that lost
 *      files after installation (a half-copied backup restore, an antivirus
 *      quarantine) and says nothing about whether the install was ever right.
 *   3. Every name in `requires` resolves. Those names were read out of the
 *      installed binaries' own load metadata, so this check keeps failing even
 *      when the extractor, the file list and the byte counts all agree with
 *      each other and are all wrong together. That is the property the previous
 *      `actual >= fileCount` test could not have: it compared the extractor's
 *      output to a number the same extractor produced.
 *
 * `existsSync` follows symlinks, so a link whose target never landed reads as
 * missing here - which is exactly the macOS/Linux failure this replaces.
 */
export function isInstalled(userDataDir: string, tag: string, probe: LlamaFsProbe = defaultLlamaFsProbe): boolean {
  const receipt = readReceipt(userDataDir, tag, probe);
  if (!receipt) return false;
  const dir = installDir(userDataDir, tag);
  if (!probe.existsSync(path.join(dir, receipt.serverRelPath))) return false;
  for (const rel of receipt.files) {
    if (!probe.existsSync(path.join(dir, rel))) return false;
  }
  for (const name of receipt.requires) {
    if (!probe.existsSync(path.join(dir, name))) return false;
  }
  return true;
}

/** Sort release tags (`b10437`) newest-first; unparseable tags sort last. */
function compareTagsDesc(a: string, b: string): number {
  const na = Number.parseInt(a.replace(/^b/, ''), 10);
  const nb = Number.parseInt(b.replace(/^b/, ''), 10);
  const va = Number.isFinite(na) ? na : -1;
  const vb = Number.isFinite(nb) ? nb : -1;
  if (va !== vb) return vb - va;
  return a < b ? 1 : a > b ? -1 : 0;
}

/** Installed, verified release tags, newest first. */
export function listInstalledTags(userDataDir: string, probe: LlamaFsProbe = defaultLlamaFsProbe): string[] {
  const dir = versionsDir(userDataDir);
  if (!probe.existsSync(dir)) return [];
  let names: string[];
  try {
    names = probe.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((tag) => isInstalled(userDataDir, tag, probe)).toSorted(compareTagsDesc);
}

/**
 * Absolute path of the managed `llama-server`, or null when none is installed.
 *
 * Pass `tag` to pin a release; otherwise the newest installed one wins. This is
 * the function `LocalServeManager.llamaServerCandidates` is meant to call.
 */
export function installedServerPath(
  userDataDir: string,
  tag?: string,
  probe: LlamaFsProbe = defaultLlamaFsProbe
): string | null {
  const tags = tag ? [tag] : listInstalledTags(userDataDir, probe);
  for (const candidate of tags) {
    const receipt = readReceipt(userDataDir, candidate, probe);
    if (!receipt) continue;
    if (!isInstalled(userDataDir, candidate, probe)) continue;
    return path.join(installDir(userDataDir, candidate), receipt.serverRelPath);
  }
  return null;
}

/**
 * Every managed `llama-server` path, newest release first.
 *
 * Shaped for `new LocalServeManager({ llamaServerCandidates: () => ... })`,
 * which takes a sync `string[]` and probes each for executability.
 */
export function llamaServerCandidates(userDataDir: string, probe: LlamaFsProbe = defaultLlamaFsProbe): string[] {
  const out: string[] = [];
  for (const tag of listInstalledTags(userDataDir, probe)) {
    const p = installedServerPath(userDataDir, tag, probe);
    if (p) out.push(p);
  }
  return out;
}
