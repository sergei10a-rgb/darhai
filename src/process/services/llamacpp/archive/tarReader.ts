/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Streaming `.tar.gz` extractor for llama.cpp macOS/Linux release archives.
 *
 * `tar` appears in this repo's `overrides` block but is not a declared
 * dependency, so importing it would be reaching into a transitive package.
 * A ustar reader is ~100 lines and lets the gunzip output be consumed a chunk
 * at a time, which matters for the same reason as in `zipReader`: nothing here
 * ever holds a whole archive in memory.
 *
 * Three details this must get right, all measured from the real archives:
 *   - Every entry lives under a single `llama-<tag>/` directory, which is
 *     stripped (detected, not hard-coded - see `commonRootPrefix`).
 *   - `llama-server` is mode 0755. Losing the executable bit on macOS/Linux
 *     produces an EACCES at spawn time, so the mode is carried through and
 *     applied on write.
 *   - Most of the archive is SYMLINKS. MEASURED on b10441: macos-arm64 is 43
 *     regular files + 18 symlinks + 1 directory, ubuntu-x64 is 52 + 10 + 1.
 *     Keeping only regular files leaves `libllama.0.1.0.dylib` on disk while
 *     the `@rpath/libllama.0.dylib` every binary names is gone, so the spawn
 *     dies with `dyld: Library not loaded`. Links are materialised, and any
 *     member type this reader does not understand raises instead of being
 *     dropped - see {@link assertComplete}.
 *
 * Peak memory is one archive's worth of inflated regular files, because the
 * root prefix cannot be detected until every name has been seen. MEASURED on
 * b10441: 27.6 MB (macos-arm64, 43 files) and 41.9 MB (ubuntu-x64, 52 files) -
 * small enough to hold, unlike the 489 MB Windows cudart archive that
 * `zipReader` streams entry by entry.
 */

import { createReadStream } from 'node:fs';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
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

const BLOCK = 512;

type TarHeader = { name: string; size: number; mode: number; typeFlag: string; linkName: string };

/**
 * Truncate at the first NUL. A `/\0.*$/` regex would say this more directly but
 * puts a control character in a regex literal, which `no-control-regex` rejects.
 */
function untilNul(value: string): string {
  const nul = value.indexOf('\u0000');
  return nul === -1 ? value : value.slice(0, nul);
}

/** Parse a NUL-terminated octal field; tar pads these with spaces and NULs. */
function readOctal(block: Buffer, offset: number, length: number): number {
  const raw = untilNul(block.toString('ascii', offset, offset + length)).trim();
  if (raw.length === 0) return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

/** Read a NUL-terminated string field. */
function readString(block: Buffer, offset: number, length: number): string {
  return untilNul(block.toString('utf8', offset, offset + length));
}

/** True when a 512-byte block is entirely zero (the end-of-archive marker). */
function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/** Decode one ustar header block. */
function parseHeader(block: Buffer): TarHeader {
  const name = readString(block, 0, 100);
  const prefix = readString(block, 345, 155);
  const magic = block.toString('ascii', 257, 262);
  const full = magic === 'ustar' && prefix.length > 0 ? `${prefix}/${name}` : name;
  return {
    name: full,
    size: readOctal(block, 124, 12),
    mode: readOctal(block, 100, 8),
    typeFlag: String.fromCharCode(block[156] || 0x30),
    linkName: readString(block, 157, 100),
  };
}

/**
 * Read a `path=` / `linkpath=` override out of a pax extended header.
 *
 * The b10441 tarballs are plain ustar, but GNU tar emits pax records the moment
 * a name exceeds 100 bytes or a uid exceeds 2097151. Parsing the two fields
 * that can change where a member lands is cheaper than the alternative, which
 * is writing the truncated ustar name and never noticing.
 */
function parsePaxOverrides(data: Buffer): { path?: string; linkpath?: string } {
  const out: { path?: string; linkpath?: string } = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(data.toString('ascii', offset, space), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break;
    const record = data.toString('utf8', space + 1, offset + length).replace(/\n$/, '');
    const eq = record.indexOf('=');
    if (eq > 0) {
      const key = record.slice(0, eq);
      if (key === 'path') out.path = record.slice(eq + 1);
      else if (key === 'linkpath') out.linkpath = record.slice(eq + 1);
    }
    offset += length;
  }
  return out;
}

/** One decoded member, with its payload already collected. */
type PendingEntry = { header: TarHeader; chunks: Buffer[] };

/**
 * Feed gunzipped tar bytes through a block state machine.
 *
 * Payloads are collected per entry rather than streamed to disk because the
 * files inside the llama.cpp tarballs are small (largest measured: an 8 MB
 * dylib) and buffering one at a time keeps the state machine honest. The
 * *archive* is still never buffered - only the current member.
 */
class TarParser {
  private buffer: Buffer = Buffer.alloc(0);
  private pending: PendingEntry | null = null;
  private remaining = 0;
  private padding = 0;
  private longName: string | null = null;
  private longLink: string | null = null;
  private pax: { path?: string; linkpath?: string } = {};
  private finished = false;

  constructor(private readonly onEntry: (header: TarHeader, data: Buffer) => Promise<void>) {}

  async push(chunk: Buffer): Promise<void> {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    await this.drain();
  }

  private async drain(): Promise<void> {
    while (!this.finished) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, this.buffer.length);
        if (take === 0) return;
        this.pending?.chunks.push(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.remaining -= take;
        if (this.remaining > 0) return;
        continue;
      }
      if (this.padding > 0) {
        const take = Math.min(this.padding, this.buffer.length);
        if (take === 0) return;
        this.buffer = this.buffer.subarray(take);
        this.padding -= take;
        if (this.padding > 0) return;
      }
      if (this.pending) {
        const entry = this.pending;
        this.pending = null;
        await this.emit(entry);
        continue;
      }
      if (this.buffer.length < BLOCK) return;
      const block = this.buffer.subarray(0, BLOCK);
      this.buffer = this.buffer.subarray(BLOCK);
      if (isZeroBlock(block)) {
        this.finished = true;
        return;
      }
      const header = parseHeader(block);
      this.remaining = header.size;
      this.padding = header.size % BLOCK === 0 ? 0 : BLOCK - (header.size % BLOCK);
      this.pending = { header, chunks: [] };
    }
  }

  /** Dispatch a fully-read member, applying any name-override records first. */
  private async emit(entry: PendingEntry): Promise<void> {
    const data = Buffer.concat(entry.chunks);
    const flag = entry.header.typeFlag;
    if (flag === 'L') {
      this.longName = untilNul(data.toString('utf8'));
      return;
    }
    if (flag === 'K') {
      this.longLink = untilNul(data.toString('utf8'));
      return;
    }
    if (flag === 'x') {
      this.pax = parsePaxOverrides(data);
      return;
    }
    if (flag === 'g') {
      // A global header sets defaults for the rest of the archive. Nothing we
      // read from it changes where a member lands, so it is skipped - but it is
      // skipped by name, not by falling off the end of a filter.
      return;
    }
    const header: TarHeader = {
      ...entry.header,
      name: this.pax.path ?? this.longName ?? entry.header.name,
      linkName: this.pax.linkpath ?? this.longLink ?? entry.header.linkName,
    };
    this.longName = null;
    this.longLink = null;
    this.pax = {};
    await this.onEntry(header, data);
  }
}

/** Member types this reader knows how to put on disk. */
const REGULAR_FLAGS = new Set(['0', '\0', '', '7']);
const HARD_LINK = '1';
const SYM_LINK = '2';
const DIRECTORY = '5';

/**
 * Extract a `.tar.gz` into `destDir`, stripping a single shared root directory
 * when the archive has one. Returns the entries written, in archive order.
 */
export async function extractTarGz(tarPath: string, destDir: string): Promise<ArchiveEntry[]> {
  // Two passes: collect names to detect the root prefix, then write. Detecting
  // the prefix needs every name, so the members are held rather than streamed.
  const members: { header: TarHeader; data: Buffer }[] = [];
  const parser = new TarParser(async (header, data) => {
    const flag = header.typeFlag;
    if (REGULAR_FLAGS.has(flag) || flag === HARD_LINK || flag === SYM_LINK || flag === DIRECTORY) {
      members.push({ header, data });
      return;
    }
    // Character/block devices, FIFOs, sparse files: nothing llama.cpp ships,
    // and nothing that can be turned into a file without guessing. Refusing is
    // the whole point - a dropped member is what made a broken install look
    // complete in the first place.
    throw new ArchiveError('ARCHIVE_UNSUPPORTED_ENTRY', `${header.name}: unsupported tar entry type "${flag}"`);
  });

  const source = createReadStream(tarPath).pipe(createGunzip());
  for await (const chunk of source) {
    await parser.push(chunk as Buffer);
  }

  if (members.length === 0) throw new ArchiveError('ARCHIVE_MALFORMED', 'tar contained no members');

  const root = commonRootPrefix(members.map((m) => m.header.name));
  const written: ArchiveEntry[] = [];
  const links: ArchiveLink[] = [];
  let declared = 0;

  for (const { header, data } of members) {
    const rel = stripRoot(header.name, root);
    if (rel === null) continue;
    const mode = header.mode > 0 ? header.mode & 0o7777 : 0o644;

    if (header.typeFlag === DIRECTORY) {
      await mkdir(safeEntryPath(destDir, rel.replace(/\/+$/, '')), { recursive: true });
      continue;
    }

    declared++;
    if (header.typeFlag === HARD_LINK || header.typeFlag === SYM_LINK) {
      const hard = header.typeFlag === HARD_LINK;
      const target = hard ? (stripRoot(header.linkName, root) ?? header.linkName) : header.linkName;
      // Validate the path now so an unsafe link fails before any file is
      // touched, the same way a regular entry does.
      safeEntryPath(destDir, rel);
      links.push({ relPath: rel, target, hard, mode });
      continue;
    }

    const target = safeEntryPath(destDir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { mode });
    // writeFile's `mode` is only applied at create time; chmod makes the
    // executable bit stick even when the file already existed.
    await chmod(target, mode);
    written.push({ relPath: rel, bytes: data.length, mode, kind: 'file', linkTarget: null });
  }

  // Links go last: a chain such as `libggml.dylib -> libggml.0.dylib ->
  // libggml.0.20.0.dylib` can only be copy-resolved once the real file exists.
  written.push(...(await materializeLinks(destDir, links)));

  if (written.length === 0) throw new ArchiveError('ARCHIVE_MALFORMED', 'tar contained no extractable files');
  assertComplete(written, declared, path.basename(tarPath));
  return written;
}
