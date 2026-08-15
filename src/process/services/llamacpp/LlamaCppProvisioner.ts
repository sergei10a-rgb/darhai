/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Puts a runnable `llama-server` on the machine.
 *
 * This is the piece that closes the "install something else first" gap: today
 * `LocalServeManager.resolveLlamaServer()` searches PATH and then
 * `llamaServerCandidates()`, which is hard-coded to `() => []`, so a machine
 * without a hand-installed llama.cpp reports `llamaServer: false` and the flow
 * degrades to printing a shell command. After this runs, `installedServerPath`
 * returns a real path and that dep has something to return.
 *
 * Ordering is what makes it safe to kill at any moment:
 *
 *   1. resolve   - release metadata, including the per-asset sha256
 *   2. download  - into `downloads/<asset>.part`, resuming with an HTTP Range
 *                  request when a partial file is already there
 *   3. verify    - hash the file *as it sits on disk*, compare to the API digest
 *   4. extract   - into `staging/<tag>-<rand>/`
 *   5. link-check - read the extracted binaries' own load metadata and require
 *                  every install-local library they name to be present
 *   6. install   - write the receipt, then rename staging -> `versions/<tag>`,
 *                  then delete the archives it no longer needs
 *
 * Step 3 hashes from disk rather than accumulating over the stream because a
 * resumed download has no single stream to accumulate over - and because the
 * question worth answering is "are the bytes on disk correct", not "were the
 * bytes I just received correct". A mismatch deletes the partial file, so the
 * next attempt starts clean instead of resuming corruption forever.
 *
 * Step 5 exists because steps 1-4 can all succeed and still produce a tree that
 * cannot run: correct bytes, correct digest, an extractor that reported
 * success, and a `llama-server` whose libraries are missing. It is the only
 * check here whose expectation does not come from this file - see
 * `binaryDeps.ts`.
 *
 * Nothing survives a failure. The staging directory is removed on every path
 * out, so retrying after a full disk does not have to fight the space the last
 * attempt is still holding.
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { HwfitBackend } from '@/common/types/hwfit';
import type { ArchiveEntry } from './archiveEntry';
import { planLlamaAssets, type LlamaAssetPlanResult, type LlamaAssetRef } from './assetMap';
import { collectInstallRequirements } from './binaryDeps';
import { extractZip } from './zipReader';
import { extractTarGz } from './tarReader';
import { LlamaReleaseClient, type LlamaRelease } from './releaseClient';
import {
  RECEIPT_NAME,
  RECEIPT_SCHEMA,
  downloadsDir,
  installDir,
  installedServerPath,
  isInstalled,
  stagingDir,
  versionsDir,
  type LlamaInstallReceipt,
  type LlamaInstalledAsset,
} from './installLayout';

export type LlamaProvisionErrorCode =
  | 'LLAMACPP_UNSUPPORTED'
  | 'LLAMACPP_NO_ASSET'
  | 'LLAMACPP_NO_DIGEST'
  | 'LLAMACPP_DIGEST_MISMATCH'
  | 'LLAMACPP_DOWNLOAD_FAILED'
  | 'LLAMACPP_EXTRACT_FAILED'
  | 'LLAMACPP_INSTALL_INCOMPLETE'
  | 'LLAMACPP_SERVER_MISSING'
  | 'LLAMACPP_CANCELLED';

/**
 * How long a staging directory may sit untouched before a later install treats
 * it as abandoned. A whole install measured 20.6 s on the reference machine, so
 * an hour cannot collide with a live one - including a second app instance.
 */
const STALE_STAGING_MS = 60 * 60 * 1000;

export class LlamaProvisionError extends Error {
  constructor(
    public readonly code: LlamaProvisionErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'LlamaProvisionError';
  }
}

/** Coarse stage of the install, for a progress bar that means something. */
export type LlamaProvisionPhase = 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'installing' | 'done';

export type LlamaProvisionProgress = {
  phase: LlamaProvisionPhase;
  /** Asset currently being worked on, or null outside per-asset phases. */
  assetName: string | null;
  /** 1-based position of `assetName` in the plan. */
  assetIndex: number;
  assetCount: number;
  /** Bytes done for the current asset. */
  bytesDone: number;
  /** Size of the current asset, or null when unknown. */
  bytesTotal: number | null;
  /** Bytes done across every asset in the plan. */
  totalBytesDone: number;
  /** Sum of every asset's size, or null when any is unknown. */
  totalBytesTotal: number | null;
};

export type LlamaProvisionEvents = {
  progress: (p: LlamaProvisionProgress) => void;
};

export type LlamaInstallResult = {
  tag: string;
  serverPath: string;
  installDir: string;
  /** True when the tag was already installed and nothing was downloaded. */
  cached: boolean;
  receipt: LlamaInstallReceipt;
};

export type LlamaProvisionRequest = {
  /** Absolute `app.getPath('userData')`. */
  userDataDir: string;
  backend: HwfitBackend;
  /** Defaults to `process.platform` / `process.arch`. */
  platform?: string;
  arch?: string;
  /** Pin a release tag; omit for the latest. */
  tag?: string;
  /** Skip the ~373 MB cudart archive because the DLLs already resolve. */
  cudaRuntimePresent?: boolean;
  cudaVariant?: string;
};

/** Injectable I/O so tests never touch the network. */
export type LlamaProvisionDeps = {
  fetch: typeof globalThis.fetch;
  releaseClient: LlamaReleaseClient;
  extractZip: typeof extractZip;
  extractTarGz: typeof extractTarGz;
  now: () => Date;
};

/** Hash a file as it sits on disk. Streamed - these are up to 500 MB. */
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/** Byte size of a file, or 0 when it does not exist. */
async function sizeOf(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath);
    return s.size;
  } catch {
    return 0;
  }
}

export class LlamaCppProvisioner extends EventEmitter {
  private readonly deps: LlamaProvisionDeps;
  private controller: AbortController | null = null;

  constructor(deps?: Partial<LlamaProvisionDeps>) {
    super();
    this.deps = {
      fetch: (input, init) => globalThis.fetch(input, init),
      releaseClient: deps?.releaseClient || new LlamaReleaseClient(deps?.fetch ? { fetch: deps.fetch } : undefined),
      extractZip,
      extractTarGz,
      now: () => new Date(),
      ...deps,
    };
  }

  override emit<K extends keyof LlamaProvisionEvents>(event: K, ...args: Parameters<LlamaProvisionEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof LlamaProvisionEvents>(event: K, listener: LlamaProvisionEvents[K]): this {
    return super.on(event, listener);
  }

  /**
   * Work out what this machine would download, without downloading it.
   *
   * The UI calls this to show a size and, when the requested backend has no
   * build, the fallback reason - before the user commits to 500 MB.
   */
  async plan(request: LlamaProvisionRequest): Promise<{ release: LlamaRelease; plan: LlamaAssetPlanResult }> {
    const release = await this.deps.releaseClient.fetchRelease(request.tag);
    const plan = planLlamaAssets({
      platform: request.platform || process.platform,
      arch: request.arch || process.arch,
      backend: request.backend,
      tag: release.tag,
      availableAssets: release.assets.map((a) => a.name),
      cudaRuntimePresent: request.cudaRuntimePresent,
      cudaVariant: request.cudaVariant,
    });
    return { release, plan };
  }

  /** True when a complete, verified install already exists for `tag`. */
  isInstalled(userDataDir: string, tag: string): boolean {
    return isInstalled(userDataDir, tag);
  }

  /** Path of the newest managed `llama-server`, or null. */
  installedServerPath(userDataDir: string, tag?: string): string | null {
    return installedServerPath(userDataDir, tag);
  }

  /** Abort an in-flight install. The partial download survives for a later resume. */
  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  /**
   * Ensure a runnable `llama-server` exists, downloading and installing when it
   * does not. Returns immediately (`cached: true`) when the tag is already
   * installed, so this is safe to call on every serve attempt.
   */
  async ensureInstalled(request: LlamaProvisionRequest, signal?: AbortSignal): Promise<LlamaInstallResult> {
    const { userDataDir } = request;

    // A pinned tag that is already on disk is answered from disk. The check has
    // to come BEFORE `plan()`, because `plan()` fetches the release index: with
    // it second, a machine that is fully installed still fails on a network
    // that is down, which is the one situation where nothing needs the network.
    if (request.tag !== undefined && isInstalled(userDataDir, request.tag)) {
      return this.cachedResult(userDataDir, request.tag);
    }

    const { release, plan } = await this.plan(request);
    if (plan.kind === 'unsupported') {
      throw new LlamaProvisionError('LLAMACPP_UNSUPPORTED', plan.reason);
    }
    const tag = release.tag;

    if (isInstalled(userDataDir, tag)) return this.cachedResult(userDataDir, tag);

    const controller = new AbortController();
    this.controller = controller;
    if (signal) {
      if (signal.aborted) throw new LlamaProvisionError('LLAMACPP_CANCELLED', 'cancelled before start');
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let staging: string | null = null;
    try {
      const refs = plan.assets;
      const sized = refs.map((ref) => {
        const asset = release.assets.find((a) => a.name === ref.name);
        if (!asset) {
          throw new LlamaProvisionError('LLAMACPP_NO_ASSET', `release ${tag} has no asset named "${ref.name}"`);
        }
        if (!asset.sha256) {
          // The API serves a digest for every current release asset; a missing
          // one means we would be trusting the transfer, which is the one thing
          // this layer exists to avoid.
          throw new LlamaProvisionError(
            'LLAMACPP_NO_DIGEST',
            `release ${tag} asset "${ref.name}" has no sha256 digest; refusing to install unverified bytes`
          );
        }
        return { ref, asset };
      });

      const totalBytesTotal = sized.reduce((sum, s) => sum + s.asset.bytes, 0) || null;
      let totalBytesDone = 0;

      await mkdir(downloadsDir(userDataDir), { recursive: true });
      await this.sweepStaleStaging(userDataDir);
      staging = path.join(stagingDir(userDataDir), `${tag}-${Math.random().toString(36).slice(2, 10)}`);
      await mkdir(staging, { recursive: true });

      const installedAssets: LlamaInstalledAsset[] = [];
      const extracted = new Set<string>();

      for (let i = 0; i < sized.length; i++) {
        const { ref, asset } = sized[i];
        const position = { assetName: ref.name, assetIndex: i + 1, assetCount: sized.length };
        const archivePath = path.join(downloadsDir(userDataDir), ref.name);

        await this.fetchAsset(archivePath, asset.url, asset.bytes, controller.signal, (bytesDone) => {
          this.emitProgress(
            { phase: 'downloading', ...position },
            bytesDone,
            asset.bytes || null,
            totalBytesDone + bytesDone,
            totalBytesTotal
          );
        });

        this.emitProgress(
          { phase: 'verifying', ...position },
          asset.bytes,
          asset.bytes || null,
          totalBytesDone + asset.bytes,
          totalBytesTotal
        );
        const actual = await sha256File(archivePath);
        if (actual !== asset.sha256) {
          // Delete rather than keep: a corrupt partial that is left in place
          // would be "resumed" forever, never converging on a good file.
          await rm(archivePath, { force: true });
          throw new LlamaProvisionError(
            'LLAMACPP_DIGEST_MISMATCH',
            `${ref.name}: expected sha256 ${asset.sha256}, got ${actual}`
          );
        }

        this.emitProgress(
          { phase: 'extracting', ...position },
          asset.bytes,
          asset.bytes || null,
          totalBytesDone + asset.bytes,
          totalBytesTotal
        );
        for (const entry of await this.extract(ref, archivePath, staging)) extracted.add(entry.relPath);
        installedAssets.push({ name: ref.name, sha256: asset.sha256, bytes: asset.bytes });
        totalBytesDone += asset.bytes;
      }

      this.emitProgress(
        { phase: 'installing', assetName: null, assetIndex: sized.length, assetCount: sized.length },
        0,
        null,
        totalBytesDone,
        totalBytesTotal
      );

      const serverStaged = path.join(staging, plan.serverBinaryName);
      if (!fs.existsSync(serverStaged)) {
        throw new LlamaProvisionError(
          'LLAMACPP_SERVER_MISSING',
          `extracted archives contain no "${plan.serverBinaryName}"`
        );
      }

      const files = [...extracted].toSorted();
      // Ask the extracted binaries what they need, then check the staging tree
      // against THAT rather than against our own idea of what we wrote. This is
      // where a dropped `libllama.0.dylib` stops being invisible.
      const stagingDirPath = staging;
      const requires = await collectInstallRequirements(stagingDirPath, files);
      const unresolved = requires.filter((name) => !fs.existsSync(path.join(stagingDirPath, name)));
      if (unresolved.length > 0) {
        throw new LlamaProvisionError(
          'LLAMACPP_INSTALL_INCOMPLETE',
          `extracted tree is missing ${unresolved.length} librar(y/ies) its own binaries load: ${unresolved.join(', ')}`
        );
      }

      const receipt: LlamaInstallReceipt = {
        schema: RECEIPT_SCHEMA,
        tag,
        platform: plan.platform,
        arch: plan.arch,
        requestedBackend: plan.requestedBackend,
        acceleration: plan.acceleration,
        fallback: plan.fallback,
        serverRelPath: plan.serverBinaryName,
        assets: installedAssets,
        files,
        requires,
        installedAt: this.deps.now().toISOString(),
      };
      // The receipt is the LAST thing written into staging, so a directory that
      // has one is a directory whose extraction finished.
      await writeFile(path.join(staging, RECEIPT_NAME), JSON.stringify(receipt, null, 2), 'utf8');

      const finalDir = installDir(userDataDir, tag);
      await mkdir(versionsDir(userDataDir), { recursive: true });
      await this.commit(staging, finalDir);
      staging = null;
      // The archives have been verified and unpacked, so keeping them buys
      // nothing and costs their full size forever. MEASURED on the reference
      // machine: 513 MB of CUDA archives were retained per install, per upgrade.
      await this.discardArchives(userDataDir, installedAssets);

      this.emitProgress(
        { phase: 'done', assetName: null, assetIndex: sized.length, assetCount: sized.length },
        0,
        null,
        totalBytesDone,
        totalBytesTotal
      );

      return {
        tag,
        serverPath: path.join(finalDir, plan.serverBinaryName),
        installDir: finalDir,
        cached: false,
        receipt,
      };
    } catch (err) {
      // Every failure below the mkdir - cancel, digest mismatch, a full disk
      // mid-inflate - used to leave its staging tree behind, so pressing "Try
      // again" after an ENOSPC consumed the space that would have let it
      // succeed. One owner, one cleanup, on every path out.
      if (staging !== null) await rm(staging, { recursive: true, force: true }).catch((): void => undefined);
      throw err;
    } finally {
      this.controller = null;
    }
  }

  /** An install that is already on disk, reported without touching the network. */
  private cachedResult(userDataDir: string, tag: string): LlamaInstallResult {
    const serverPath = installedServerPath(userDataDir, tag);
    const receipt = readReceiptOrThrow(userDataDir, tag);
    this.emitProgress({ phase: 'done', assetName: null, assetIndex: 0, assetCount: 0 }, 0, null, 0, null);
    return { tag, serverPath: serverPath || '', installDir: installDir(userDataDir, tag), cached: true, receipt };
  }

  /** Delete the verified archives an install no longer needs. */
  private async discardArchives(userDataDir: string, assets: readonly LlamaInstalledAsset[]): Promise<void> {
    for (const asset of assets) {
      const archive = path.join(downloadsDir(userDataDir), asset.name);
      await rm(archive, { force: true }).catch((): void => undefined);
      await rm(`${archive}.part`, { force: true }).catch((): void => undefined);
    }
  }

  /**
   * Remove staging directories a previous run never got to clean up.
   *
   * The per-attempt cleanup above covers anything that threw; this covers the
   * process that was killed outright. Only directories older than
   * {@link STALE_STAGING_MS} are touched, so a second app instance extracting
   * right now is never pulled out from under itself.
   */
  private async sweepStaleStaging(userDataDir: string): Promise<void> {
    const root = stagingDir(userDataDir);
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
    if (fs.existsSync(path.join(finalDir, RECEIPT_NAME))) {
      await rm(staging, { recursive: true, force: true });
      return;
    }
    await rm(finalDir, { recursive: true, force: true });
    await rename(staging, finalDir);
  }

  /** Dispatch to the right extractor and return what landed. */
  private async extract(ref: LlamaAssetRef, archivePath: string, staging: string): Promise<ArchiveEntry[]> {
    try {
      return ref.format === 'zip'
        ? await this.deps.extractZip(archivePath, staging)
        : await this.deps.extractTarGz(archivePath, staging);
    } catch (err) {
      throw new LlamaProvisionError(
        'LLAMACPP_EXTRACT_FAILED',
        `${ref.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Download `url` to `destPath`, resuming from a `.part` file when one exists.
   *
   * A 500 MB transfer will be interrupted, so restarting from zero every time is
   * not an option. The `.part` file is appended to under an HTTP Range request;
   * a server that ignores the range (200 instead of 206) causes a clean restart
   * from zero rather than a silently spliced, corrupt file.
   */
  private async fetchAsset(
    destPath: string,
    url: string,
    expectedBytes: number,
    signal: AbortSignal,
    onBytes: (bytesDone: number) => void
  ): Promise<void> {
    if (fs.existsSync(destPath)) {
      // Already downloaded on an earlier attempt; the digest check still runs.
      onBytes(await sizeOf(destPath));
      return;
    }
    const partPath = `${destPath}.part`;
    let already = await sizeOf(partPath);
    if (expectedBytes > 0 && already >= expectedBytes) {
      // A .part at or past the full size is not resumable - it is wrong.
      await rm(partPath, { force: true });
      already = 0;
    }

    const headers: Record<string, string> = {};
    if (already > 0) headers.range = `bytes=${already}-`;

    let response: Response;
    try {
      response = await this.deps.fetch(url, { signal, headers });
    } catch (err) {
      if (signal.aborted) throw new LlamaProvisionError('LLAMACPP_CANCELLED', 'download cancelled');
      throw new LlamaProvisionError(
        'LLAMACPP_DOWNLOAD_FAILED',
        `${url}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!response.ok || !response.body) {
      throw new LlamaProvisionError(
        'LLAMACPP_DOWNLOAD_FAILED',
        `${url} -> ${response.status} ${response.statusText || ''}`.trim()
      );
    }

    // 206 means the range was honoured and we append. Anything else (notably a
    // plain 200) means the server is sending the whole file, so start over.
    const resuming = already > 0 && response.status === 206;
    if (!resuming && already > 0) {
      await rm(partPath, { force: true });
      already = 0;
    }

    let bytesDone = already;
    onBytes(bytesDone);
    const handle = await open(partPath, resuming ? 'a' : 'w');
    try {
      const sink = createWriteStream('', { fd: handle.fd, autoClose: false });
      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      source.on('data', (chunk: Buffer) => {
        bytesDone += chunk.length;
        onBytes(bytesDone);
      });
      await pipeline(source, sink);
    } catch (err) {
      if (signal.aborted) throw new LlamaProvisionError('LLAMACPP_CANCELLED', 'download cancelled mid-stream');
      throw new LlamaProvisionError(
        'LLAMACPP_DOWNLOAD_FAILED',
        `${url}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      await handle.close();
    }

    await rename(partPath, destPath);
  }

  /** Assemble and emit one progress event. */
  private emitProgress(
    head: { phase: LlamaProvisionPhase; assetName: string | null; assetIndex: number; assetCount: number },
    bytesDone: number,
    bytesTotal: number | null,
    totalBytesDone: number,
    totalBytesTotal: number | null
  ): void {
    this.emit('progress', { ...head, bytesDone, bytesTotal, totalBytesDone, totalBytesTotal });
  }
}

/** Read a receipt we have already proved exists, or fail loudly. */
function readReceiptOrThrow(userDataDir: string, tag: string): LlamaInstallReceipt {
  const file = path.join(installDir(userDataDir, tag), RECEIPT_NAME);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as LlamaInstallReceipt;
}
