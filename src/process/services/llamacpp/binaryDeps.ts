/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What the installed binaries say they need, read out of the binaries themselves.
 *
 * This exists to break a self-reference. Everything else that describes an
 * install - the file list, the byte counts - is produced by the extractor, so a
 * bug in the extractor produces a matching, self-consistent, wrong description
 * that the readiness check then certifies. The names below come from upstream's
 * own link metadata (Mach-O `LC_ID_DYLIB`/`LC_LOAD_DYLIB`, ELF `DT_SONAME`/
 * `DT_NEEDED`), which no amount of extractor breakage can change.
 *
 * Only *install-local* names are collected, so a missing system library is
 * never blamed on us:
 *   - Mach-O: a dependency spelled `@rpath/…`, `@loader_path/…` or
 *     `@executable_path/…` can only be satisfied from inside the install.
 *   - ELF: a `DT_NEEDED` name counts only when some library shipped in the same
 *     install declares that exact name as its `DT_SONAME`. `libggml-base.so.0`
 *     qualifies (it is the SONAME of `libggml-base.so.0.20.0`); `libc.so.6`
 *     never does.
 *   - Every SONAME/install-name itself must exist as a file, because that is
 *     the name a loader will look for.
 *
 * MEASURED against the real b10441 release: with a correct extraction, 0 of
 * these names are unresolved on macos-arm64 and 0 on ubuntu-x64. With the
 * symlink-dropping extraction this replaces, 9 and 5 are unresolved
 * respectively - so the check fails exactly when the install is broken and not
 * otherwise. Windows contributes nothing: PE files are not parsed, which is why
 * `assertComplete` in the archive readers, not this module, is what protects
 * the Windows path.
 */

import { open } from 'node:fs/promises';
import path from 'node:path';

/** Mach-O 64- and 32-bit, little-endian. Fat archives are deliberately not parsed. */
const MH_MAGIC_64 = 0xfeedfacf;
const MH_MAGIC_32 = 0xfeedface;

const LC_ID_DYLIB = 0x0d;
const LC_LOAD_DYLIB = 0x0c;
const LC_REEXPORT_DYLIB = 0x8000001f;

const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_SONAME = 14;

const PT_LOAD = 1;
const PT_DYNAMIC = 2;

/**
 * Cap on how much of one file is read. The largest library in any llama.cpp
 * release archive is 9.6 MB (`libllama-server-impl.dylib`, measured on b10441);
 * the cap only ever excludes something that is not a Mach-O or ELF anyway.
 */
const MAX_BINARY_BYTES = 64 * 1024 * 1024;

/** The link identity and dependencies one binary declares about itself. */
export type BinaryLinkInfo = {
  format: 'macho' | 'elf';
  /** Install name / SONAME, or null when the binary is an executable. */
  id: string | null;
  /** Non-weak dependency names, exactly as the binary spells them. */
  deps: string[];
};

/** Truncate at the first NUL, the way both formats terminate their strings. */
function untilNul(value: string): string {
  const nul = value.indexOf('\u0000');
  return nul === -1 ? value : value.slice(0, nul);
}

/** Read the load commands of a thin, little-endian Mach-O. */
function readMachO(buf: Buffer): BinaryLinkInfo | null {
  if (buf.length < 32) return null;
  const magic = buf.readUInt32LE(0);
  if (magic !== MH_MAGIC_64 && magic !== MH_MAGIC_32) return null;
  const ncmds = buf.readUInt32LE(16);
  let offset = magic === MH_MAGIC_64 ? 32 : 28;
  const out: BinaryLinkInfo = { format: 'macho', id: null, deps: [] };
  for (let i = 0; i < ncmds; i++) {
    if (offset + 8 > buf.length) break;
    const cmd = buf.readUInt32LE(offset);
    const size = buf.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > buf.length) break;
    if (cmd === LC_ID_DYLIB || cmd === LC_LOAD_DYLIB || cmd === LC_REEXPORT_DYLIB) {
      const nameOffset = buf.readUInt32LE(offset + 8);
      if (nameOffset >= 8 && nameOffset < size) {
        const name = untilNul(buf.toString('utf8', offset + nameOffset, offset + size));
        if (cmd === LC_ID_DYLIB) out.id = name;
        else out.deps.push(name);
      }
    }
    offset += size;
  }
  return out;
}

/** Read the dynamic section of a 64-bit, little-endian ELF. */
function readElf(buf: Buffer): BinaryLinkInfo | null {
  if (buf.length < 64) return null;
  if (buf.toString('latin1', 0, 4) !== '\x7fELF') return null;
  if (buf[4] !== 2 || buf[5] !== 1) return null; // 64-bit, little-endian only
  const phoff = Number(buf.readBigUInt64LE(32));
  const phentsize = buf.readUInt16LE(54);
  const phnum = buf.readUInt16LE(56);
  const loads: { off: number; vaddr: number; filesz: number }[] = [];
  let dynOffset = 0;
  let dynSize = 0;
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (p + 56 > buf.length) return null;
    const type = buf.readUInt32LE(p);
    const off = Number(buf.readBigUInt64LE(p + 8));
    const vaddr = Number(buf.readBigUInt64LE(p + 16));
    const filesz = Number(buf.readBigUInt64LE(p + 32));
    if (type === PT_LOAD) loads.push({ off, vaddr, filesz });
    if (type === PT_DYNAMIC) {
      dynOffset = off;
      dynSize = filesz;
    }
  }
  if (dynSize === 0) return null;

  // Dynamic entries hold virtual addresses; the string table has to be mapped
  // back to a file offset through the loadable segments.
  const toFileOffset = (vaddr: number): number => {
    for (const l of loads) {
      if (vaddr >= l.vaddr && vaddr < l.vaddr + l.filesz) return l.off + (vaddr - l.vaddr);
    }
    return -1;
  };

  let strtab = -1;
  for (let p = dynOffset; p + 16 <= dynOffset + dynSize && p + 16 <= buf.length; p += 16) {
    const tag = Number(buf.readBigInt64LE(p));
    if (tag === DT_NULL) break;
    if (tag === DT_STRTAB) strtab = toFileOffset(Number(buf.readBigUInt64LE(p + 8)));
  }
  if (strtab < 0 || strtab >= buf.length) return null;

  const readStr = (index: number): string =>
    untilNul(buf.toString('utf8', strtab + index, Math.min(strtab + index + 4096, buf.length)));

  const out: BinaryLinkInfo = { format: 'elf', id: null, deps: [] };
  for (let p = dynOffset; p + 16 <= dynOffset + dynSize && p + 16 <= buf.length; p += 16) {
    const tag = Number(buf.readBigInt64LE(p));
    if (tag === DT_NULL) break;
    const value = Number(buf.readBigUInt64LE(p + 8));
    if (tag === DT_SONAME) out.id = readStr(value);
    else if (tag === DT_NEEDED) out.deps.push(readStr(value));
  }
  return out;
}

/** Parse whichever of the two formats this buffer is, or null for anything else. */
export function readBinaryLinkInfo(buf: Buffer): BinaryLinkInfo | null {
  return readMachO(buf) ?? readElf(buf);
}

/** True when a Mach-O dependency can only be satisfied from inside the install. */
function isMachOLocal(dep: string): boolean {
  return dep.startsWith('@rpath/') || dep.startsWith('@loader_path/') || dep.startsWith('@executable_path/');
}

/** Read one file's link metadata without pulling a 400 MB DLL into memory. */
async function readOne(file: string): Promise<BinaryLinkInfo | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, 4, 0);
    if (bytesRead < 4) return null;
    const looksMachO = magic.readUInt32LE(0) === MH_MAGIC_64 || magic.readUInt32LE(0) === MH_MAGIC_32;
    const looksElf = magic.toString('latin1') === '\x7fELF';
    if (!looksMachO && !looksElf) return null;
    const { size } = await handle.stat();
    if (size > MAX_BINARY_BYTES) return null;
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, size, 0);
    return readBinaryLinkInfo(buf);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Library names an install must contain for its own binaries to load.
 *
 * Returned sorted and de-duplicated so a receipt written twice from the same
 * tree is byte-identical. An empty result means nothing in the tree was a
 * Mach-O or ELF - the normal Windows outcome - and is not an error.
 */
export async function collectInstallRequirements(dir: string, relPaths: readonly string[]): Promise<string[]> {
  const parsed: BinaryLinkInfo[] = [];
  for (const rel of relPaths) {
    const info = await readOne(path.join(dir, rel));
    if (info !== null) parsed.push(info);
  }

  const sonames = new Set<string>();
  for (const info of parsed) {
    if (info.id !== null && info.id.length > 0) sonames.add(path.posix.basename(info.id));
  }

  const required = new Set<string>(sonames);
  for (const info of parsed) {
    for (const dep of info.deps) {
      if (info.format === 'macho') {
        if (isMachOLocal(dep)) required.add(path.posix.basename(dep));
      } else if (sonames.has(dep)) {
        required.add(dep);
      }
    }
  }
  return [...required].toSorted();
}
