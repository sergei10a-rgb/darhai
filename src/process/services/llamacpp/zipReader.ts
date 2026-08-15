/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Streaming ZIP extractor for llama.cpp Windows release archives.
 *
 * Why not `jszip` (already a dependency): `JSZip.loadAsync` materialises the
 * whole archive plus every inflated entry in the JS heap. The archives this
 * must handle are `cudart-llama-bin-win-cuda-13.3-x64.zip` at 373 MB
 * compressed / 489 MB inflated (measured: one entry, `cublasLt64_13.dll`, is
 * 439 MB on its own). Buffering that in the Electron main process is how you
 * turn a download into an OOM. This reads the central directory, then streams
 * each entry through `zlib.createInflateRaw()` into its destination file, so
 * peak memory is a couple of stream buffers regardless of archive size.
 *
 * Scope is deliberately narrow: store (method 0) and deflate (method 8), which
 * is everything the llama.cpp releases use. Anything else raises rather than
 * writing a corrupt file.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import {
  ArchiveError,
  assertComplete,
  commonRootPrefix,
  materializeLinks,
  safeEntryPath,
  stripRoot,
  type ArchiveEntry,
  type ArchiveLink,
} from './archiveEntry';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** EOCD lives in the last 64 KiB + comment; scan a bit more for the zip64 locator. */
const TAIL_SCAN_BYTES = 66_000;

type CentralEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  externalAttrs: number;
};

/** Read an exact byte range from an open file handle. */
async function readRange(fd: Awaited<ReturnType<typeof open>>, start: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fd.read(buf, done, length - done, start + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  if (done !== length) {
    throw new ArchiveError('ARCHIVE_MALFORMED', `short read: wanted ${length} at ${start}, got ${done}`);
  }
  return buf;
}

/** Locate the central directory, following the zip64 records when present. */
async function readCentralDirectory(zipPath: string): Promise<CentralEntry[]> {
  const fd = await open(zipPath, 'r');
  try {
    const { size } = await fd.stat();
    const tailLen = Math.min(TAIL_SCAN_BYTES, size);
    const tail = await readRange(fd, size - tailLen, tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ArchiveError('ARCHIVE_MALFORMED', 'end-of-central-directory record not found');

    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      let locator = -1;
      for (let i = eocd - 20; i >= 0; i--) {
        if (tail.readUInt32LE(i) === SIG_EOCD64_LOCATOR) {
          locator = i;
          break;
        }
      }
      if (locator < 0) throw new ArchiveError('ARCHIVE_MALFORMED', 'zip64 locator missing');
      const eocd64Offset = Number(tail.readBigUInt64LE(locator + 8));
      const eocd64 = await readRange(fd, eocd64Offset, 56);
      cdSize = Number(eocd64.readBigUInt64LE(40));
      cdOffset = Number(eocd64.readBigUInt64LE(48));
    }

    const cd = await readRange(fd, cdOffset, cdSize);
    return parseCentralDirectory(cd);
  } finally {
    await fd.close();
  }
}

/** Read the zip64 extended-information extra field for any 0xffffffff placeholders. */
function applyZip64Extra(entry: CentralEntry, extra: Buffer): void {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      if (entry.uncompressedSize === 0xffffffff && q + 8 <= p + 4 + len) {
        entry.uncompressedSize = Number(extra.readBigUInt64LE(q));
        q += 8;
      }
      if (entry.compressedSize === 0xffffffff && q + 8 <= p + 4 + len) {
        entry.compressedSize = Number(extra.readBigUInt64LE(q));
        q += 8;
      }
      if (entry.localOffset === 0xffffffff && q + 8 <= p + 4 + len) {
        entry.localOffset = Number(extra.readBigUInt64LE(q));
      }
      return;
    }
    p += 4 + len;
  }
}

/** Walk the central directory blob into typed entries. */
function parseCentralDirectory(cd: Buffer): CentralEntry[] {
  const entries: CentralEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === SIG_CENTRAL) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const entry: CentralEntry = {
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      uncompressedSize: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42),
      externalAttrs: cd.readUInt32LE(p + 38),
    };
    applyZip64Extra(entry, cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.length === 0) throw new ArchiveError('ARCHIVE_MALFORMED', 'central directory has no entries');
  return entries;
}

/** Byte offset of an entry's payload, read from its local file header. */
async function payloadOffset(zipPath: string, entry: CentralEntry): Promise<number> {
  const fd = await open(zipPath, 'r');
  try {
    const header = await readRange(fd, entry.localOffset, 30);
    if (header.readUInt32LE(0) !== SIG_LOCAL) {
      throw new ArchiveError('ARCHIVE_MALFORMED', `bad local header for ${entry.name}`);
    }
    return entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await fd.close();
  }
}

/** POSIX mode bits a zip carries in the high half of its external attributes. */
function zipMode(externalAttrs: number): number | null {
  const mode = (externalAttrs >>> 16) & 0xffff;
  return mode > 0 ? mode & 0o7777 : null;
}

/** `S_IFLNK` in the same high half. A zip symlink stores its target as the payload. */
function isZipSymlink(externalAttrs: number): boolean {
  return ((externalAttrs >>> 16) & 0xf000) === 0xa000;
}

/** Read one entry's payload into memory. Only used for link targets, which are one line. */
async function readEntryBytes(zipPath: string, entry: CentralEntry, start: number): Promise<Buffer> {
  const source = createReadStream(zipPath, { start, end: start + entry.compressedSize - 1 });
  const chunks: Buffer[] = [];
  const collect = async (stream: NodeJS.ReadableStream): Promise<void> => {
    for await (const chunk of stream) chunks.push(chunk as Buffer);
  };
  if (entry.method === METHOD_DEFLATE) {
    const inflate = createInflateRaw();
    source.pipe(inflate);
    await collect(inflate);
  } else {
    await collect(source);
  }
  return Buffer.concat(chunks);
}

/**
 * Extract a zip into `destDir`, stripping a single shared root directory when
 * the archive has one. Returns the entries written, in archive order.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<ArchiveEntry[]> {
  const central = await readCentralDirectory(zipPath);
  const root = commonRootPrefix(central.map((e) => e.name));
  const written: ArchiveEntry[] = [];
  const links: ArchiveLink[] = [];
  let declared = 0;

  for (const entry of central) {
    const rel = stripRoot(entry.name, root);
    if (rel === null) continue;
    if (rel.endsWith('/')) {
      // Directory entry: create it, but it is not a written file.
      await mkdir(safeEntryPath(destDir, rel.slice(0, -1)), { recursive: true });
      continue;
    }
    if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
      throw new ArchiveError(
        'ARCHIVE_UNSUPPORTED_METHOD',
        `${entry.name} uses compression method ${entry.method}; only store and deflate are supported`
      );
    }

    declared++;
    const target = safeEntryPath(destDir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    const start = await payloadOffset(zipPath, entry);

    if (isZipSymlink(entry.externalAttrs)) {
      // A zip written on macOS/Linux stores a symlink as an ordinary entry
      // whose bytes are the target name. Writing those bytes as file content
      // would put the string "libggml.0.dylib" where a library belongs.
      const payload = await readEntryBytes(zipPath, entry, start);
      links.push({
        relPath: rel,
        target: payload.toString('utf8').trim(),
        hard: false,
        mode: zipMode(entry.externalAttrs),
      });
      continue;
    }

    const source = createReadStream(zipPath, { start, end: start + entry.compressedSize - 1 });
    const sink = createWriteStream(target, { mode: zipMode(entry.externalAttrs) ?? 0o644 });
    if (entry.method === METHOD_DEFLATE) {
      await pipeline(source, createInflateRaw(), sink);
    } else {
      await pipeline(source, sink);
    }

    written.push({
      relPath: rel,
      bytes: entry.uncompressedSize,
      mode: zipMode(entry.externalAttrs),
      kind: 'file',
      linkTarget: null,
    });
  }

  written.push(...(await materializeLinks(destDir, links)));

  if (written.length === 0) throw new ArchiveError('ARCHIVE_MALFORMED', 'zip contained no files');
  assertComplete(written, declared, path.basename(zipPath));
  return written;
}
