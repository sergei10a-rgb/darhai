/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resumable HTTP download to a `.part` file, finished with an atomic rename.
 *
 * This is `LlamaCppProvisioner.fetchAsset` extracted verbatim so the Mongolian
 * voice provisioner (a 931 MB GGUF and a ~600 MB TTS bundle) can share it
 * instead of growing a second, slightly different copy. The algorithm is
 * unchanged:
 *
 *   - `destPath` already exists: report its size and return - an earlier
 *     attempt finished the transfer, and the caller's digest check still runs.
 *   - a `.part` at or past the full size is not resumable - it is wrong, so it
 *     is deleted and the transfer starts from zero.
 *   - otherwise the `.part` is appended to under an HTTP Range request. A 206
 *     means the range was honoured; anything else (notably a plain 200) means
 *     the server is sending the whole file, so the partial is discarded rather
 *     than silently spliced into a corrupt file.
 *   - only a fully received body is renamed `.part` -> `destPath`, so a file at
 *     the final path always holds a complete transfer.
 *
 * Failures are typed, not stringly: `CANCELLED` when the abort signal fired,
 * `FAILED` for everything else. Callers map these onto their own error
 * vocabulary (`LLAMACPP_*`, `VOICE_*`) using {@link ResumeDownloadError.detail}
 * so the human-readable part survives the translation unchanged.
 */

import { createWriteStream } from 'node:fs';
import fs from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type ResumeDownloadErrorCode = 'CANCELLED' | 'FAILED';

export class ResumeDownloadError extends Error {
  constructor(
    public readonly code: ResumeDownloadErrorCode,
    /** The message without the code prefix, for callers that re-wrap. */
    public readonly detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ResumeDownloadError';
  }
}

export type ResumeDownloadOptions = {
  url: string;
  /** Final path of the completed download; the partial lives at `<destPath>.part`. */
  destPath: string;
  /** Full payload size when known, 0 when not; used only to invalidate an oversized partial. */
  expectedBytes: number;
  signal: AbortSignal;
  fetch: typeof globalThis.fetch;
  /** Called with the total bytes on disk so far, including a resumed prefix. */
  onBytes: (n: number) => void;
};

/** Byte size of a file, or 0 when it does not exist. */
async function sizeOf(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath);
    return s.size;
  } catch {
    return 0;
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
export async function resumeDownload(opts: ResumeDownloadOptions): Promise<void> {
  const { url, destPath, expectedBytes, signal, fetch, onBytes } = opts;
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
    response = await fetch(url, { signal, headers });
  } catch (err) {
    if (signal.aborted) throw new ResumeDownloadError('CANCELLED', 'download cancelled');
    throw new ResumeDownloadError('FAILED', `${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok || !response.body) {
    throw new ResumeDownloadError('FAILED', `${url} -> ${response.status} ${response.statusText || ''}`.trim());
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
    if (signal.aborted) throw new ResumeDownloadError('CANCELLED', 'download cancelled mid-stream');
    throw new ResumeDownloadError('FAILED', `${url}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await handle.close();
  }

  await rename(partPath, destPath);
}
