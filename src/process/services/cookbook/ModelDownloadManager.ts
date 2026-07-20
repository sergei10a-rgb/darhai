/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Atomic GGUF download primitive for the cookbook-serve path.
 *
 * A direct port of {@link VoiceAssetManager}'s contract: stream a URL into
 * `<dest>.tmp` while accumulating a SHA-256, verify against the pinned hash on
 * completion, and atomically rename only on success. Any other outcome unlinks
 * the `.tmp` so a half-written file never poses as a valid asset.
 *
 * Net-new piece over VoiceAssetManager: {@link ModelDownloadManager.resolveGgufFile}
 * hits the Hugging Face HTTP tree API to pick the `*.gguf` matching the ranked
 * quant and resolve its download URL + byte size. GGUF repos almost never pin a
 * SHA in-app, so this reuses VoiceAssetManager's empty-sha graceful contract:
 * an unpinned hash warns (does not block).
 *
 * `// secondary:` HTTP-Range resume is deferred - a failed download re-downloads
 * from zero on the next attempt for the MVP.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Typed error surfaced to the caller (and through the serve layer). */
export type CookbookDownloadErrorCode =
  | 'COOKBOOK_DOWNLOAD_OFFLINE'
  | 'COOKBOOK_DOWNLOAD_FETCH_FAILED'
  | 'COOKBOOK_DOWNLOAD_HASH_MISMATCH'
  | 'COOKBOOK_DOWNLOAD_CANCELLED'
  | 'COOKBOOK_DOWNLOAD_NO_GGUF';

export class CookbookDownloadError extends Error {
  constructor(
    public readonly code: CookbookDownloadErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'CookbookDownloadError';
  }
}

/**
 * Injectable I/O seam. Production wires this to node:fs + globalThis.fetch;
 * unit tests substitute fakes so the network and the filesystem stay out.
 */
export type CookbookDownloadIo = {
  fetch: typeof globalThis.fetch;
  exists: (p: string) => boolean;
  ensureDir: (p: string) => Promise<void>;
  openWrite: (p: string) => Promise<{
    write: (chunk: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
  }>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (p: string) => Promise<void>;
};

export const defaultCookbookDownloadIo: CookbookDownloadIo = {
  fetch: (input, init) => globalThis.fetch(input, init),
  exists: existsSync,
  ensureDir: async (p) => {
    await mkdir(p, { recursive: true });
  },
  openWrite: async (p) => {
    const stream = createWriteStream(p);
    return {
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          stream.write(chunk, (err) => (err ? reject(err) : resolve()));
        }),
      close: () =>
        new Promise<void>((resolve, reject) => {
          stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
        }),
    };
  },
  rename: (from, to) => rename(from, to),
  unlink: async (p) => {
    try {
      await unlink(p);
    } catch {
      // Best-effort cleanup - ENOENT and friends are fine.
    }
  },
};

/** Descriptor for one GGUF download. `quant` biases the file pick. */
export type CookbookDownloadDescriptor = {
  /** The catalog model name - drives the deterministic local filename. */
  modelId: string;
  /** Hugging Face repo id holding the GGUF build (e.g. "org/Model-GGUF"). */
  repo: string;
  /** Preferred quant label (e.g. "Q4_K_M"); empty picks a ranked default. */
  quant?: string;
  /** Directory the verified .gguf lands in. */
  destDir: string;
};

export type CookbookDownloadProgress = { modelId: string; bytesDownloaded: number; totalBytes: number | null };
export type CookbookDownloadResult = { modelId: string; filePath: string; cached: boolean; bytesWritten: number };

/** One entry of the Hugging Face `/api/models/{repo}/tree/main` listing. */
type HfTreeEntry = { type?: string; path?: string; size?: number };

/** The resolved GGUF file to fetch. */
export type ResolvedGgufFile = { url: string; fileName: string; sizeBytes: number | null };

const TMP_SUFFIX = '.tmp';
const HF_BASE = 'https://huggingface.co';

/**
 * Ranked default GGUF quant preference (best balance first). Used when the
 * model's requested quant is not present in the repo listing.
 */
const DEFAULT_QUANT_RANK = ['Q4_K_M', 'Q4_K_S', 'Q4_0', 'Q5_K_M', 'Q5_K_S', 'Q6_K', 'Q8_0', 'Q3_K_M', 'Q2_K'] as const;

/** Sanitize a model name into a safe, deterministic local filename stem. */
export function localGgufFileName(modelId: string): string {
  const stem = modelId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
  return `${stem}.gguf`;
}

/** Absolute path a model's cached .gguf lives at. */
export function localGgufPath(destDir: string, modelId: string): string {
  return path.join(destDir, localGgufFileName(modelId));
}

/**
 * Normalize a quant label for substring matching against a filename
 * (uppercase, strip separators): "q4_k_m" and "Q4-K-M" both -> "Q4KM".
 */
function normalizeQuant(q: string): string {
  return q.toUpperCase().replace(/[-_. ]/g, '');
}

/**
 * Pick the best GGUF file from a repo tree listing given a preferred quant.
 *
 * Skips multi-part shards except the first (`...00001-of-...`) so a single
 * download yields a runnable file. Prefers an exact quant match, then the
 * ranked defaults, then any remaining GGUF.
 */
export function pickGgufFile(entries: readonly HfTreeEntry[], quant?: string): HfTreeEntry | null {
  const files = entries.filter(
    (e) => e.type === 'file' && typeof e.path === 'string' && e.path.toLowerCase().endsWith('.gguf')
  );
  if (files.length === 0) return null;

  // Drop shard parts beyond the first so we never download only a fragment.
  const nonShardParts = files.filter((f) => {
    const m = /-(\d{5})-of-\d{5}\.gguf$/i.exec(f.path || '');
    return !m || m[1] === '00001';
  });
  const pool = nonShardParts.length > 0 ? nonShardParts : files;

  if (quant && quant.trim().length > 0) {
    const wanted = normalizeQuant(quant);
    const exact = pool.find((f) => normalizeQuant(f.path || '').includes(wanted));
    if (exact) return exact;
  }

  for (const q of DEFAULT_QUANT_RANK) {
    const wanted = normalizeQuant(q);
    const hit = pool.find((f) => normalizeQuant(f.path || '').includes(wanted));
    if (hit) return hit;
  }

  return pool[0];
}

/**
 * Content-addressed GGUF downloader with an in-flight cancel registry keyed by
 * model id. One instance per service; the download + serve orchestrator owns it.
 */
export class ModelDownloadManager {
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly io: CookbookDownloadIo = defaultCookbookDownloadIo) {}

  /** True when the model's .gguf is already cached on disk. */
  isDownloaded(destDir: string, modelId: string): boolean {
    return this.io.exists(localGgufPath(destDir, modelId));
  }

  /**
   * Resolve the concrete GGUF file to download from a Hugging Face repo. Hits
   * the tree API (`/api/models/{repo}/tree/main`), picks the file matching the
   * ranked quant, and returns its `resolve/main/{path}` URL + byte size.
   */
  async resolveGgufFile(repo: string, quant?: string): Promise<ResolvedGgufFile> {
    const treeUrl = `${HF_BASE}/api/models/${repo}/tree/main`;
    let response: Response;
    try {
      response = await this.io.fetch(treeUrl, { headers: { accept: 'application/json' } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CookbookDownloadError('COOKBOOK_DOWNLOAD_OFFLINE', msg);
    }
    if (!response.ok) {
      throw new CookbookDownloadError(
        'COOKBOOK_DOWNLOAD_FETCH_FAILED',
        `HF tree ${response.status} ${response.statusText || ''}`.trim()
      );
    }
    let entries: HfTreeEntry[];
    try {
      const body = (await response.json()) as unknown;
      entries = Array.isArray(body) ? (body as HfTreeEntry[]) : [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CookbookDownloadError('COOKBOOK_DOWNLOAD_FETCH_FAILED', `HF tree parse failed: ${msg}`);
    }

    const chosen = pickGgufFile(entries, quant);
    if (!chosen || !chosen.path) {
      throw new CookbookDownloadError('COOKBOOK_DOWNLOAD_NO_GGUF', `no .gguf file in ${repo}`);
    }
    return {
      url: `${HF_BASE}/${repo}/resolve/main/${chosen.path}`,
      fileName: chosen.path,
      sizeBytes: typeof chosen.size === 'number' && Number.isFinite(chosen.size) ? chosen.size : null,
    };
  }

  /**
   * Download a model's GGUF build. Short-circuits when the deterministic local
   * path already exists (cached), otherwise resolves the file from Hugging Face
   * and streams it atomically into place. GGUF hashes are unpinned, so a valid
   * completed stream is accepted with a one-line warning (never blocked).
   */
  async download(
    descriptor: CookbookDownloadDescriptor,
    onProgress?: (p: CookbookDownloadProgress) => void,
    signal?: AbortSignal
  ): Promise<CookbookDownloadResult> {
    const destPath = localGgufPath(descriptor.destDir, descriptor.modelId);

    if (this.io.exists(destPath)) {
      return { modelId: descriptor.modelId, filePath: destPath, cached: true, bytesWritten: 0 };
    }

    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) {
        throw new CookbookDownloadError('COOKBOOK_DOWNLOAD_CANCELLED', 'download cancelled before start');
      }
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.active.set(descriptor.modelId, controller);

    const tmpPath = destPath + TMP_SUFFIX;
    try {
      const resolved = await this.resolveGgufFile(descriptor.repo, descriptor.quant);

      await this.io.ensureDir(path.dirname(destPath));
      const writer = await this.io.openWrite(tmpPath);

      let response: Response;
      try {
        response = await this.io.fetch(resolved.url, { signal: controller.signal });
      } catch (err) {
        await writer.close();
        await this.io.unlink(tmpPath);
        if (controller.signal.aborted) {
          throw new CookbookDownloadError('COOKBOOK_DOWNLOAD_CANCELLED', 'download cancelled');
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new CookbookDownloadError('COOKBOOK_DOWNLOAD_OFFLINE', msg);
      }

      if (!response.ok || !response.body) {
        await writer.close();
        await this.io.unlink(tmpPath);
        throw new CookbookDownloadError(
          'COOKBOOK_DOWNLOAD_FETCH_FAILED',
          `${response.status} ${response.statusText || ''}`.trim()
        );
      }

      const contentLength = response.headers.get('content-length');
      const totalBytes = contentLength ? Number.parseInt(contentLength, 10) : resolved.sizeBytes;

      const hash = createHash('sha256');
      let bytesWritten = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (controller.signal.aborted) {
            throw new CookbookDownloadError('COOKBOOK_DOWNLOAD_CANCELLED', 'download cancelled mid-stream');
          }
          hash.update(value);
          await writer.write(value);
          bytesWritten += value.byteLength;
          onProgress?.({ modelId: descriptor.modelId, bytesDownloaded: bytesWritten, totalBytes });
        }
      } catch (err) {
        await writer.close();
        await this.io.unlink(tmpPath);
        throw err;
      }

      await writer.close();

      // GGUF builds ship no in-app pinned SHA. Surface a one-line warning so the
      // operator knows an unverified download landed, but do not block - this
      // mirrors VoiceAssetManager's empty-sha graceful contract.
      console.warn(
        `[ModelDownloadManager] ${descriptor.modelId} downloaded without integrity check; ` +
          `sha256 not pinned (computed=${hash.digest('hex')}).`
      );

      await this.io.rename(tmpPath, destPath);
      return { modelId: descriptor.modelId, filePath: destPath, cached: false, bytesWritten };
    } finally {
      this.active.delete(descriptor.modelId);
    }
  }

  /** Cancel an in-flight download by model id. Returns true if a cancel was issued. */
  cancel(modelId: string): boolean {
    const controller = this.active.get(modelId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}
