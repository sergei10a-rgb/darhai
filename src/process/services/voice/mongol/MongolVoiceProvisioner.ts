/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Puts the Mongolian voice core on the machine
 * (docs/architecture/mongolian-voice.md).
 *
 * Three components, one discipline - the llama.cpp provisioner's, repeated
 * deliberately rather than approximately:
 *
 *   1. refuse   - an unpinned hash or an unsupported platform fails BEFORE any
 *                 network call. Unlike `voiceAssetRegistry`, an empty sha256 is
 *                 not "download unverified and warn": these archives put
 *                 executable code on disk, so it is a bug in the manifest table
 *                 and the install fails closed with `VOICE_HASH_UNPINNED`.
 *   2. download - via the shared `resumeDownload` (Range resume, 200-restart,
 *                 atomic `.part` rename) into `downloads/`.
 *   3. verify   - stream-hash the file as it sits on disk. The GGUF is 931 MB;
 *                 nothing here ever buffers a payload in memory. A mismatch
 *                 deletes the file so the next attempt starts clean instead of
 *                 resuming corruption forever.
 *   4. extract  - zips into `staging/<tag>-<rand>/`; the entry the component
 *                 keys readiness on (`audiocpp_server.exe`, the bundle's
 *                 `entry`) must exist or nothing is installed.
 *   5. install  - the receipt is the LAST file written into staging, then the
 *                 directory is renamed into `versions/<tag>`. A process killed
 *                 at any point leaves either nothing, or a directory that has
 *                 already passed the receipt write. Single-file payloads skip
 *                 staging: verify happens in `downloads/`, then one atomic
 *                 rename puts the model at its final path.
 *
 * Verified archives are deleted after extraction - keeping them buys nothing
 * and costs their full size forever (the llama.cpp install measured 513 MB of
 * retained archives per upgrade before it learned the same rule).
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { safeEntryPath } from '../../llamacpp/archive/archiveEntry';
import { ResumeDownloadError, resumeDownload } from '../../llamacpp/resumeDownload';
import { extractZip } from '../../llamacpp/archive/zipReader';
import {
  KITTEN_BUNDLE_MANIFEST_NAME,
  MONGOL_VOICE_ASSETS,
  STT_SERVER_RELPATH,
  mongolVoiceSupport,
  parseKittenBundleManifest,
  type MongolVoiceComponent,
  type MongolVoicePinnedAsset,
} from './manifest';
import {
  VOICE_RECEIPT_NAME,
  VOICE_RECEIPT_SCHEMA,
  componentInstallDir,
  componentVersionsDir,
  isSttModelInstalled,
  isVoiceComponentInstalled,
  sttModelPath,
  sttModelsDir,
  voiceDownloadsDir,
  voiceStagingDir,
  type MongolVoiceReceipt,
} from './installLayout';

export type MongolVoiceProvisionErrorCode =
  | 'VOICE_HASH_UNPINNED'
  | 'VOICE_PLATFORM_UNSUPPORTED'
  | 'VOICE_HASH_MISMATCH'
  | 'VOICE_BUNDLE_INVALID'
  | 'VOICE_ENTRY_MISSING'
  | 'VOICE_DOWNLOAD_FAILED'
  | 'VOICE_CANCELLED';

export class MongolVoiceProvisionError extends Error {
  constructor(
    public readonly code: MongolVoiceProvisionErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'MongolVoiceProvisionError';
  }
}

/**
 * How long a staging directory may sit untouched before a later install treats
 * it as abandoned. Same window as the llama.cpp provisioner, for the same
 * reason: a live extraction is minutes old, so an hour cannot collide with one.
 */
const STALE_STAGING_MS = 60 * 60 * 1000;

export type MongolVoicePhase = 'download' | 'verify' | 'extract' | 'finalize';

export type MongolVoiceProgress = {
  component: MongolVoiceComponent;
  phase: MongolVoicePhase;
  bytesDone: number;
  bytesTotal: number;
};

export type MongolVoiceEvents = {
  progress: (p: MongolVoiceProgress) => void;
};

export type MongolVoiceComponentStatus = {
  /** Whether this platform/arch has anything to download at all. */
  supported: boolean;
  /** Whether the asset carries a sha256; unpinned assets refuse to install. */
  pinned: boolean;
  installed: boolean;
  tag: string;
  bytes: number;
};

export type MongolVoiceStatus = Record<MongolVoiceComponent, MongolVoiceComponentStatus>;

/**
 * Injectable I/O so tests never touch the network - and, via `assets`, can pin
 * a hash to fixture bytes. Production always runs on the defaults, where the
 * pinned table in `manifest.ts` is the single source of truth.
 */
export type MongolVoiceDeps = {
  fetch: typeof globalThis.fetch;
  extractZip: typeof extractZip;
  now: () => Date;
  platform: string;
  arch: string;
  assets: readonly MongolVoicePinnedAsset[];
};

/** Hash a file as it sits on disk. Streamed - the GGUF is 931 MB. */
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/** On-disk filename of an asset's payload: its pinned filename, else the URL basename. */
function downloadName(asset: MongolVoicePinnedAsset): string {
  if (typeof asset.filename === 'string' && asset.filename.length > 0) return asset.filename;
  const tail = asset.url.split('/').pop();
  return typeof tail === 'string' && tail.length > 0 ? tail : `${asset.component}-${asset.tag}`;
}

export class MongolVoiceProvisioner extends EventEmitter {
  private readonly deps: MongolVoiceDeps;
  private readonly controllers = new Map<MongolVoiceComponent, AbortController>();
  /**
   * One in-flight install per component. A second `install()` for the same
   * component joins this promise instead of starting a second download racing
   * into the same `.part` file (reachable from the UI: close Settings
   * mid-install, reopen, press "Install" again). Because there is exactly one
   * job, `controllers` holds exactly one controller per component and
   * `cancel()` aborts the job every caller is waiting on.
   */
  private readonly inFlight = new Map<MongolVoiceComponent, Promise<void>>();

  constructor(
    private readonly userDataDir: string,
    deps?: Partial<MongolVoiceDeps>
  ) {
    super();
    this.deps = {
      fetch: (input, init) => globalThis.fetch(input, init),
      extractZip,
      now: () => new Date(),
      platform: process.platform,
      arch: process.arch,
      assets: MONGOL_VOICE_ASSETS,
      ...deps,
    };
  }

  override emit<K extends keyof MongolVoiceEvents>(event: K, ...args: Parameters<MongolVoiceEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof MongolVoiceEvents>(event: K, listener: MongolVoiceEvents[K]): this {
    return super.on(event, listener);
  }

  /** What each component looks like right now, without touching the network. */
  status(): MongolVoiceStatus {
    return {
      'stt-runtime': this.componentStatus('stt-runtime'),
      'stt-model': this.componentStatus('stt-model'),
      'tts-bundle': this.componentStatus('tts-bundle'),
    };
  }

  /** Abort an in-flight install of `component`. The partial download survives for a later resume. */
  cancel(component: MongolVoiceComponent): boolean {
    const controller = this.controllers.get(component);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  /**
   * Ensure `component` is installed, downloading and installing when it is
   * not. Returns immediately when a complete install already exists, so this
   * is safe to call on every use. While an install of `component` is already
   * in flight, this joins it instead of starting a second one - everything up
   * to the in-flight registration is synchronous, so two concurrent calls can
   * never both miss the map and both start downloading.
   */
  async install(component: MongolVoiceComponent, signal?: AbortSignal): Promise<void> {
    const asset = this.assetFor(component);
    // The two refusals come BEFORE any network call - and before the installed
    // check, because an unpinned table row is a manifest bug that must surface
    // even on a machine that happens to have an old install lying around.
    if (asset.sha256 === '') {
      throw new MongolVoiceProvisionError(
        'VOICE_HASH_UNPINNED',
        `${component} (${asset.tag}) has no pinned sha256; refusing to download unverifiable bytes`
      );
    }
    if (this.isSupported(component) === false) {
      throw new MongolVoiceProvisionError(
        'VOICE_PLATFORM_UNSUPPORTED',
        `${component} has no build for ${this.deps.platform}/${this.deps.arch}`
      );
    }
    if (this.isComponentInstalled(asset) === true) return;
    if (signal !== undefined && signal.aborted === true) {
      throw new MongolVoiceProvisionError('VOICE_CANCELLED', 'cancelled before start');
    }

    const existing = this.inFlight.get(component);
    if (existing !== undefined) {
      // Join the running job. This caller's signal aborts that ONE job - the
      // same job `cancel()` targets - never a second parallel download.
      if (signal !== undefined) {
        const onAbort = (): void => this.controllers.get(component)?.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        return existing.finally(() => signal.removeEventListener('abort', onAbort));
      }
      return existing;
    }

    const controller = new AbortController();
    let detachSignal: (() => void) | null = null;
    if (signal !== undefined) {
      const onAbort = (): void => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      // The listener must not outlive the install: a long-lived UI signal
      // would otherwise accumulate one dead listener per completed install.
      detachSignal = (): void => signal.removeEventListener('abort', onAbort);
    }
    this.controllers.set(component, controller);
    const job = this.runInstall(component, asset, controller.signal).finally(() => {
      this.controllers.delete(component);
      this.inFlight.delete(component);
      detachSignal?.();
    });
    this.inFlight.set(component, job);
    return job;
  }

  /** The download → verify → place/extract pipeline behind one in-flight job. */
  private async runInstall(
    component: MongolVoiceComponent,
    asset: MongolVoicePinnedAsset,
    signal: AbortSignal
  ): Promise<void> {
    const payloadPath = await this.download(component, asset, signal);
    await this.verify(component, asset, payloadPath);
    if (asset.format === 'file') {
      await this.placeFile(component, asset, payloadPath);
    } else {
      await this.extractAndCommit(component, asset, payloadPath);
    }
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /** Download the payload into `downloads/`, resuming any `.part` left behind. */
  private async download(
    component: MongolVoiceComponent,
    asset: MongolVoicePinnedAsset,
    signal: AbortSignal
  ): Promise<string> {
    await mkdir(voiceDownloadsDir(this.userDataDir), { recursive: true });
    const destPath = path.join(voiceDownloadsDir(this.userDataDir), downloadName(asset));
    try {
      await resumeDownload({
        url: asset.url,
        destPath,
        expectedBytes: asset.bytes,
        signal,
        fetch: this.deps.fetch,
        onBytes: (n) => this.emitProgress(component, 'download', n, asset.bytes),
      });
    } catch (err) {
      if (err instanceof ResumeDownloadError) {
        throw new MongolVoiceProvisionError(
          err.code === 'CANCELLED' ? 'VOICE_CANCELLED' : 'VOICE_DOWNLOAD_FAILED',
          err.detail
        );
      }
      throw err;
    }
    return destPath;
  }

  /** Stream-hash the payload on disk against the pinned digest; delete it on mismatch. */
  private async verify(
    component: MongolVoiceComponent,
    asset: MongolVoicePinnedAsset,
    payloadPath: string
  ): Promise<void> {
    this.emitProgress(component, 'verify', asset.bytes, asset.bytes);
    const actual = await sha256File(payloadPath);
    if (actual !== asset.sha256) {
      // Delete rather than keep: a corrupt file that is left in place would be
      // "resumed" (or re-verified) forever, never converging on a good one.
      await rm(payloadPath, { force: true });
      throw new MongolVoiceProvisionError(
        'VOICE_HASH_MISMATCH',
        `${downloadName(asset)}: expected sha256 ${asset.sha256}, got ${actual}`
      );
    }
  }

  /**
   * A `format: 'file'` payload is its own install: it was verified where it
   * was downloaded, so one atomic rename puts it at its final path. No receipt
   * - a file at `sttModelPath` was, by construction, fully downloaded and
   * hash-verified (`isSttModelInstalled` re-checks the size).
   */
  private async placeFile(
    component: MongolVoiceComponent,
    asset: MongolVoicePinnedAsset,
    payloadPath: string
  ): Promise<void> {
    this.emitProgress(component, 'finalize', asset.bytes, asset.bytes);
    await mkdir(sttModelsDir(this.userDataDir), { recursive: true });
    await rename(payloadPath, sttModelPath(this.userDataDir, downloadName(asset)));
  }

  /** Extract into staging, validate the entry, write the receipt LAST, rename into place. */
  private async extractAndCommit(
    component: MongolVoiceComponent,
    asset: MongolVoicePinnedAsset,
    archivePath: string
  ): Promise<void> {
    await this.sweepStaleStaging();
    let staging: string | null = path.join(
      voiceStagingDir(this.userDataDir),
      `${asset.tag}-${Math.random().toString(36).slice(2, 10)}`
    );
    try {
      await mkdir(staging, { recursive: true });
      this.emitProgress(component, 'extract', asset.bytes, asset.bytes);
      const entries = await this.deps.extractZip(archivePath, staging);
      const entryRelPath = this.entryRelPathFor(component, staging);

      const receipt: MongolVoiceReceipt = {
        schema: VOICE_RECEIPT_SCHEMA,
        component,
        tag: asset.tag,
        platform: this.deps.platform,
        arch: this.deps.arch,
        asset: { url: asset.url, sha256: asset.sha256, bytes: asset.bytes },
        files: entries.map((e) => e.relPath).toSorted(),
        entryRelPath,
        installedAt: this.deps.now().toISOString(),
      };
      this.emitProgress(component, 'finalize', asset.bytes, asset.bytes);
      // The receipt is the LAST thing written into staging, so a directory
      // that has one is a directory whose extraction finished.
      await writeFile(path.join(staging, VOICE_RECEIPT_NAME), JSON.stringify(receipt, null, 2), 'utf8');

      await mkdir(componentVersionsDir(this.userDataDir, component), { recursive: true });
      await this.commit(staging, componentInstallDir(this.userDataDir, component, asset.tag));
      staging = null;
    } finally {
      // One owner, one cleanup, on every path out - a failed attempt must not
      // hold the disk space the retry needs.
      if (staging !== null) await rm(staging, { recursive: true, force: true }).catch((): void => undefined);
    }
    // The archive has been verified and unpacked; keeping it costs its full
    // size forever and buys nothing.
    await rm(archivePath, { force: true }).catch((): void => undefined);
  }

  /**
   * The install-dir-relative path readiness keys on, validated against what
   * the extraction actually produced.
   *
   * For the STT runtime that is `audiocpp_server.exe` at the extraction root.
   * For the TTS bundle it is `bundle.json`'s `entry` - the manifest is
   * Darhai's only contract with the bundle, so it is parsed here, its entry
   * containment-checked (it is untrusted input naming an executable), and the
   * file it names required to exist.
   */
  private entryRelPathFor(component: MongolVoiceComponent, staging: string): string {
    if (component === 'tts-bundle') {
      const manifestPath = path.join(staging, KITTEN_BUNDLE_MANIFEST_NAME);
      if (fs.existsSync(manifestPath) === false) {
        throw new MongolVoiceProvisionError(
          'VOICE_BUNDLE_INVALID',
          `extracted bundle has no ${KITTEN_BUNDLE_MANIFEST_NAME} at its root`
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        throw new MongolVoiceProvisionError('VOICE_BUNDLE_INVALID', `${KITTEN_BUNDLE_MANIFEST_NAME} is not valid JSON`);
      }
      const manifest = parseKittenBundleManifest(parsed);
      if (manifest === null) {
        throw new MongolVoiceProvisionError(
          'VOICE_BUNDLE_INVALID',
          `${KITTEN_BUNDLE_MANIFEST_NAME} does not satisfy the kitten-v1 contract`
        );
      }
      let entryAbs: string;
      try {
        entryAbs = safeEntryPath(staging, manifest.entry);
      } catch {
        throw new MongolVoiceProvisionError(
          'VOICE_BUNDLE_INVALID',
          `bundle entry "${manifest.entry}" escapes the bundle root`
        );
      }
      if (fs.existsSync(entryAbs) === false) {
        throw new MongolVoiceProvisionError(
          'VOICE_BUNDLE_INVALID',
          `bundle entry "${manifest.entry}" is not in the archive`
        );
      }
      return manifest.entry;
    }
    if (fs.existsSync(path.join(staging, STT_SERVER_RELPATH)) === false) {
      throw new MongolVoiceProvisionError(
        'VOICE_ENTRY_MISSING',
        `extracted runtime contains no "${STT_SERVER_RELPATH}" at its root`
      );
    }
    return STT_SERVER_RELPATH;
  }

  /** Rename staging into place, replacing any stale directory already there. */
  private async commit(staging: string, finalDir: string): Promise<void> {
    try {
      await rename(staging, finalDir);
      return;
    } catch {
      // A directory is already there. Either a concurrent install won the race
      // (in which case its receipt makes it valid and ours is redundant), or a
      // previous attempt left something broken that must go.
    }
    if (fs.existsSync(path.join(finalDir, VOICE_RECEIPT_NAME))) {
      await rm(staging, { recursive: true, force: true });
      return;
    }
    await rm(finalDir, { recursive: true, force: true });
    await rename(staging, finalDir);
  }

  /**
   * Remove staging directories a previous run never got to clean up. The
   * per-attempt cleanup covers anything that threw; this covers the process
   * that was killed outright. Only directories older than
   * {@link STALE_STAGING_MS} are touched, so a concurrent install extracting
   * right now is never pulled out from under itself.
   */
  private async sweepStaleStaging(): Promise<void> {
    const root = voiceStagingDir(this.userDataDir);
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    const cutoff = this.deps.now().getTime() - STALE_STAGING_MS;
    for (const name of names) {
      const dir = path.join(root, name);
      try {
        if ((await stat(dir)).mtimeMs >= cutoff) continue;
      } catch {
        continue;
      }
      await rm(dir, { recursive: true, force: true }).catch((): void => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  private assetFor(component: MongolVoiceComponent): MongolVoicePinnedAsset {
    const asset = this.deps.assets.find((a) => a.component === component);
    if (asset === undefined) {
      // A component with no table row cannot be verified, which is the same
      // defect class as an empty hash: a bug in the table, failing closed.
      throw new MongolVoiceProvisionError('VOICE_HASH_UNPINNED', `no pinned asset for ${component}`);
    }
    return asset;
  }

  private isSupported(component: MongolVoiceComponent): boolean {
    const support = mongolVoiceSupport(this.deps.platform, this.deps.arch);
    return component === 'tts-bundle' ? support.tts : support.stt;
  }

  private isComponentInstalled(asset: MongolVoicePinnedAsset): boolean {
    if (asset.format === 'file') {
      return isSttModelInstalled(this.userDataDir, downloadName(asset), asset.bytes);
    }
    return isVoiceComponentInstalled(this.userDataDir, asset.component, asset.tag);
  }

  private componentStatus(component: MongolVoiceComponent): MongolVoiceComponentStatus {
    const asset = this.assetFor(component);
    return {
      supported: this.isSupported(component),
      pinned: asset.sha256 !== '',
      installed: this.isComponentInstalled(asset),
      tag: asset.tag,
      bytes: asset.bytes,
    };
  }

  private emitProgress(
    component: MongolVoiceComponent,
    phase: MongolVoicePhase,
    bytesDone: number,
    bytesTotal: number
  ): void {
    this.emit('progress', { component, phase, bytesDone, bytesTotal });
  }
}
