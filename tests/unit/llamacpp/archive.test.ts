/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  ArchiveError,
  assertComplete,
  commonRootPrefix,
  safeEntryPath,
  stripRoot,
  type ArchiveEntry,
} from '@process/services/llamacpp/archiveEntry';
import { extractZip } from '@process/services/llamacpp/zipReader';
import { extractTarGz } from '@process/services/llamacpp/tarReader';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'darhai-llamacpp-arch-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/**
 * Build a zip with JSZip. Using a different implementation to write than the
 * one under test to read is deliberate: a bug shared by writer and reader would
 * otherwise cancel out and the test would pass on a broken reader.
 */
async function makeZip(files: Record<string, string | Buffer>, opts: { store?: boolean } = {}): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: opts.store ? 'STORE' : 'DEFLATE',
  });
  const file = path.join(work, `fixture-${Math.random().toString(36).slice(2)}.zip`);
  await writeFile(file, buf);
  return file;
}

/** One tar member as the fixture builder describes it. */
type TarMember = {
  data?: string | Buffer;
  mode?: number;
  /** ustar typeflag: '0' file, '1' hard link, '2' symlink, '5' directory. */
  type?: string;
  /** Target for a link member. */
  link?: string;
};

/** Write one 512-byte ustar header block. */
function tarHeader(name: string, size: number, mode: number, type = '0', link = ''): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, 'utf8');
  block.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'ascii');
  block.write('0000000\0', 108, 'ascii'); // uid
  block.write('0000000\0', 116, 'ascii'); // gid
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  block.write('00000000000\0', 136, 'ascii'); // mtime
  block.write('        ', 148, 'ascii'); // checksum placeholder
  block.write(type, 156, 'ascii');
  block.write(link.slice(0, 100), 157, 'utf8');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return block;
}

/** Build a real `.tar.gz` from a name -> member map. */
async function makeTarGz(files: Record<string, TarMember>): Promise<string> {
  const parts: Buffer[] = [];
  for (const [name, member] of Object.entries(files)) {
    const raw = member.data ?? '';
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
    // Link and directory members carry a zero-length payload, exactly as tar
    // writes them: the target lives in the header, not in the data blocks.
    const carriesData = !['1', '2', '5'].includes(member.type ?? '0');
    parts.push(
      tarHeader(name, carriesData ? body.length : 0, member.mode ?? 0o644, member.type ?? '0', member.link ?? '')
    );
    if (carriesData) {
      parts.push(body);
      const pad = body.length % 512 === 0 ? 0 : 512 - (body.length % 512);
      if (pad > 0) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  const file = path.join(work, `fixture-${Math.random().toString(36).slice(2)}.tar.gz`);
  await writeFile(file, gzipSync(Buffer.concat(parts)));
  return file;
}

describe('safeEntryPath - the archive path-traversal guard', () => {
  it('resolves an ordinary entry under the destination', () => {
    expect(safeEntryPath('/dest', 'llama-server')).toBe(path.resolve('/dest', 'llama-server'));
    expect(safeEntryPath('/dest', 'sub/dir/file.dll')).toBe(path.resolve('/dest', 'sub/dir/file.dll'));
  });

  it('refuses a parent-traversal entry', () => {
    expect(() => safeEntryPath('/dest', '../evil.sh')).toThrow(ArchiveError);
    expect(() => safeEntryPath('/dest', 'a/../../evil.sh')).toThrow(/ARCHIVE_UNSAFE_ENTRY/);
  });

  it('refuses a POSIX absolute path', () => {
    expect(() => safeEntryPath('/dest', '/etc/cron.d/evil')).toThrow(/ARCHIVE_UNSAFE_ENTRY/);
  });

  it('refuses a Windows absolute path and a UNC path', () => {
    expect(() => safeEntryPath('/dest', 'C:\\Windows\\System32\\evil.dll')).toThrow(/ARCHIVE_UNSAFE_ENTRY/);
    expect(() => safeEntryPath('/dest', '//server/share/evil.dll')).toThrow(/ARCHIVE_UNSAFE_ENTRY/);
  });

  it('refuses an empty entry name', () => {
    expect(() => safeEntryPath('/dest', '')).toThrow(/ARCHIVE_UNSAFE_ENTRY/);
  });

  it('treats a backslash-separated traversal the same as a forward-slash one', () => {
    expect(() => safeEntryPath('/dest', '..\\evil.sh')).toThrow(/ARCHIVE_UNSAFE_ENTRY/);
  });
});

describe('commonRootPrefix / stripRoot - platform layout differences', () => {
  it('detects the single root directory a tar.gz wraps everything in', () => {
    // Measured: llama-b10437-bin-ubuntu-x64.tar.gz puts every entry under llama-b10437/.
    expect(commonRootPrefix(['llama-b10437/llama-server', 'llama-b10437/libllama.so'])).toBe('llama-b10437');
  });

  it('tolerates the explicit root directory entry producers emit alongside files', () => {
    // Measured: `tar -tvzf llama-b10437-bin-ubuntu-x64.tar.gz` lists a
    // `drwxr-xr-x llama-b10437/` member, and JSZip writes the same kind of
    // entry. Treating that bare name as a root-level *file* aborts detection
    // and leaves every path prefixed.
    expect(commonRootPrefix(['llama-b10437/', 'llama-b10437/llama-server', 'llama-b10437/ggml.dll'])).toBe(
      'llama-b10437'
    );
  });

  it('detects no root when the archive is flat', () => {
    // Measured: llama-b10437-bin-win-cpu-x64.zip has 51 entries at the root.
    expect(commonRootPrefix(['llama-server.exe', 'ggml-base.dll'])).toBeNull();
  });

  it('detects no root when entries live under different directories', () => {
    expect(commonRootPrefix(['a/one', 'b/two'])).toBeNull();
  });

  it('returns null for an empty archive', () => {
    expect(commonRootPrefix([])).toBeNull();
  });

  it('strips the detected root and drops the root entry itself', () => {
    expect(stripRoot('llama-b10437/llama-server', 'llama-b10437')).toBe('llama-server');
    expect(stripRoot('llama-b10437/', 'llama-b10437')).toBeNull();
    expect(stripRoot('llama-server.exe', null)).toBe('llama-server.exe');
  });
});

describe('assertComplete - what makes a silently dropped member impossible', () => {
  const entry = (relPath: string): ArchiveEntry => ({
    relPath,
    bytes: 1,
    mode: null,
    kind: 'file',
    linkTarget: null,
  });

  it('raises when fewer members landed than the archive declared', () => {
    // The measured b10441 macos tarball declares 61 non-directory members and
    // the old reader wrote 43. Nothing noticed, and the receipt then certified
    // the 43 as complete because it counted them itself.
    expect(() => assertComplete([entry('llama-server')], 2, 'llama-b10441-bin-macos-arm64.tar.gz')).toThrow(
      /ARCHIVE_INCOMPLETE/
    );
  });

  it('names the archive and both counts, so the failure is diagnosable', () => {
    expect(() => assertComplete([entry('llama-server')], 61, 'macos.tar.gz')).toThrow(/macos\.tar\.gz.*61.*1/);
  });

  it('accepts an extraction that wrote every declared member', () => {
    expect(() => assertComplete([entry('a'), entry('b')], 2, 'x.zip')).not.toThrow();
  });
});

describe('extractZip', () => {
  it('extracts a flat Windows-style zip', async () => {
    const zip = await makeZip({
      'llama-server.exe': 'SERVER',
      'ggml-cuda.dll': 'CUDA',
      'ggml-base.dll': 'BASE',
    });
    const dest = path.join(work, 'out');
    const entries = await extractZip(zip, dest);

    expect(entries.map((e) => e.relPath).toSorted()).toEqual(['ggml-base.dll', 'ggml-cuda.dll', 'llama-server.exe']);
    expect(await readFile(path.join(dest, 'llama-server.exe'), 'utf8')).toBe('SERVER');
    expect(await readFile(path.join(dest, 'ggml-cuda.dll'), 'utf8')).toBe('CUDA');
  });

  it('strips a single shared root directory', async () => {
    const zip = await makeZip({ 'llama-b10437/llama-server.exe': 'SERVER', 'llama-b10437/ggml.dll': 'GGML' });
    const dest = path.join(work, 'out');
    const entries = await extractZip(zip, dest);
    expect(entries.map((e) => e.relPath).toSorted()).toEqual(['ggml.dll', 'llama-server.exe']);
    expect(await readFile(path.join(dest, 'llama-server.exe'), 'utf8')).toBe('SERVER');
  });

  it('handles stored (uncompressed) entries as well as deflated ones', async () => {
    const zip = await makeZip({ 'llama-server.exe': 'STORED BYTES' }, { store: true });
    const dest = path.join(work, 'out');
    await extractZip(zip, dest);
    expect(await readFile(path.join(dest, 'llama-server.exe'), 'utf8')).toBe('STORED BYTES');
  });

  it('round-trips binary content byte for byte', async () => {
    const blob = Buffer.alloc(300_000);
    for (let i = 0; i < blob.length; i++) blob[i] = (i * 31) % 256;
    const zip = await makeZip({ 'ggml.dll': blob });
    const dest = path.join(work, 'out');
    await extractZip(zip, dest);
    expect(await readFile(path.join(dest, 'ggml.dll'))).toEqual(blob);
  });

  it('preserves nested directories', async () => {
    const zip = await makeZip({ 'llama-server.exe': 'S', 'sub/dir/extra.dll': 'X' });
    const dest = path.join(work, 'out');
    await extractZip(zip, dest);
    expect(await readFile(path.join(dest, 'sub', 'dir', 'extra.dll'), 'utf8')).toBe('X');
  });

  it('refuses a zip whose entry escapes the destination', async () => {
    const zip = await makeZip({ 'llama-server.exe': 'S', '../escaped.dll': 'EVIL' });
    await expect(extractZip(zip, path.join(work, 'out'))).rejects.toThrow(/ARCHIVE_UNSAFE_ENTRY/);
  });

  it('rejects a file that is not a zip', async () => {
    const notZip = path.join(work, 'garbage.zip');
    await writeFile(notZip, Buffer.alloc(4096, 0x41));
    await expect(extractZip(notZip, path.join(work, 'out'))).rejects.toThrow(ArchiveError);
  });
});

describe('extractTarGz', () => {
  it('extracts a macOS/Linux-style tarball and strips the tag directory', async () => {
    const tar = await makeTarGz({
      'llama-b10437/llama-server': { data: 'SERVER', mode: 0o755 },
      'llama-b10437/libllama.dylib': { data: 'LIB', mode: 0o644 },
    });
    const dest = path.join(work, 'out');
    const entries = await extractTarGz(tar, dest);

    expect(entries.map((e) => e.relPath).toSorted()).toEqual(['libllama.dylib', 'llama-server']);
    expect(await readFile(path.join(dest, 'llama-server'), 'utf8')).toBe('SERVER');
  });

  it('preserves the executable bit on llama-server', async () => {
    // Measured: llama-server is -rwxr-xr-x in both the macos and ubuntu tarballs.
    // Dropping it produces an EACCES at spawn time, not at extract time.
    const tar = await makeTarGz({ 'llama-b10437/llama-server': { data: 'SERVER', mode: 0o755 } });
    const dest = path.join(work, 'out');
    const entries = await extractTarGz(tar, dest);
    expect(entries[0].mode).toBe(0o755);
    if (process.platform !== 'win32') {
      const s = await stat(path.join(dest, 'llama-server'));
      expect(s.mode & 0o111).toBeGreaterThan(0);
    }
  });

  it('handles a payload that is not a multiple of the 512-byte block', async () => {
    const odd = 'x'.repeat(513);
    const tar = await makeTarGz({
      'root/a.txt': { data: odd },
      'root/b.txt': { data: 'after the padded entry' },
    });
    const dest = path.join(work, 'out');
    await extractTarGz(tar, dest);
    expect(await readFile(path.join(dest, 'a.txt'), 'utf8')).toBe(odd);
    expect(await readFile(path.join(dest, 'b.txt'), 'utf8')).toBe('after the padded entry');
  });

  it('round-trips binary content that spans many blocks', async () => {
    const blob = Buffer.alloc(200_000);
    for (let i = 0; i < blob.length; i++) blob[i] = (i * 17 + 7) % 256;
    const tar = await makeTarGz({ 'root/lib.dylib': { data: blob } });
    const dest = path.join(work, 'out');
    await extractTarGz(tar, dest);
    expect(await readFile(path.join(dest, 'lib.dylib'))).toEqual(blob);
  });

  it('extracts a flat tarball with no root directory', async () => {
    const tar = await makeTarGz({ 'llama-server': { data: 'S' }, 'lib.so': { data: 'L' } });
    const dest = path.join(work, 'out');
    await extractTarGz(tar, dest);
    expect((await readdir(dest)).toSorted()).toEqual(['lib.so', 'llama-server']);
  });

  it('refuses a tarball whose entry escapes the destination', async () => {
    const tar = await makeTarGz({
      'root/llama-server': { data: 'S' },
      'root/../../escaped': { data: 'EVIL' },
    });
    await expect(extractTarGz(tar, path.join(work, 'out'))).rejects.toThrow(/ARCHIVE_UNSAFE_ENTRY/);
  });

  it('rejects an empty archive', async () => {
    const tar = await makeTarGz({});
    await expect(extractTarGz(tar, path.join(work, 'out'))).rejects.toThrow(/ARCHIVE_MALFORMED/);
  });
});

describe('extractTarGz - symlinks, which are most of a real llama.cpp tarball', () => {
  /**
   * MEASURED shape of `llama-b10441-bin-macos-arm64.tar.gz`: the versioned file
   * is real, every name a binary actually loads is a symlink, and one of them
   * points at another symlink.
   */
  const macosShape = {
    'llama-b10441/': { type: '5' },
    'llama-b10441/llama-server': { data: 'SERVER', mode: 0o755 },
    'llama-b10441/libllama.0.1.0.dylib': { data: 'REAL LIBLLAMA', mode: 0o755 },
    'llama-b10441/libllama.0.dylib': { type: '2', link: 'libllama.0.1.0.dylib' },
    'llama-b10441/libllama.dylib': { type: '2', link: 'libllama.0.dylib' },
  };

  it('materialises a symlink so the name the binary loads resolves', async () => {
    const tar = await makeTarGz(macosShape);
    const dest = path.join(work, 'out');
    await extractTarGz(tar, dest);

    // `libllama.0.dylib` is the name in llama-server's load commands. Before
    // this, only libllama.0.1.0.dylib landed and the spawn died in dyld.
    expect(existsSync(path.join(dest, 'libllama.0.dylib'))).toBe(true);
    expect(await readFile(path.join(dest, 'libllama.0.dylib'), 'utf8')).toBe('REAL LIBLLAMA');
  });

  it('follows a chain of symlinks to the real file', async () => {
    // libggml.dylib -> libggml.0.dylib -> libggml.0.20.0.dylib is shipped.
    const tar = await makeTarGz(macosShape);
    const dest = path.join(work, 'out');
    await extractTarGz(tar, dest);
    expect(await readFile(path.join(dest, 'libllama.dylib'), 'utf8')).toBe('REAL LIBLLAMA');
  });

  it('returns every link as an entry, so nothing is silently dropped', async () => {
    const tar = await makeTarGz(macosShape);
    const entries = await extractTarGz(tar, path.join(work, 'out'));
    expect(entries.map((e) => e.relPath).toSorted()).toEqual([
      'libllama.0.1.0.dylib',
      'libllama.0.dylib',
      'libllama.dylib',
      'llama-server',
    ]);
    expect(
      entries
        .filter((e) => e.kind === 'link')
        .map((e) => e.linkTarget)
        .toSorted()
    ).toEqual(['libllama.0.1.0.dylib', 'libllama.0.dylib']);
  });

  it('resolves a hard link against the archive root, not the entry directory', async () => {
    const tar = await makeTarGz({
      'llama-b10441/llama-server': { data: 'SERVER', mode: 0o755 },
      'llama-b10441/sub/alias': { type: '1', link: 'llama-b10441/llama-server' },
    });
    const dest = path.join(work, 'out');
    await extractTarGz(tar, dest);
    expect(await readFile(path.join(dest, 'sub', 'alias'), 'utf8')).toBe('SERVER');
  });

  it('refuses a symlink that points outside the archive', async () => {
    const tar = await makeTarGz({
      'llama-b10441/llama-server': { data: 'S' },
      'llama-b10441/escape': { type: '2', link: '/etc/passwd' },
    });
    await expect(extractTarGz(tar, path.join(work, 'out'))).rejects.toThrow(/ARCHIVE_UNSAFE_ENTRY/);
  });

  it('refuses a symlink whose RELATIVE target climbs out of the tree', async () => {
    // The absolute case above was the only one covered. `..` is the same door
    // with a different key: nothing rejects it, so the finished install holds a
    // link that reads a file the archive never shipped - and the receipt lists
    // it as an ordinary member.
    const secret = path.join(work, 'OUTSIDE-SECRET.txt');
    await writeFile(secret, 'SECRET BYTES');
    const tar = await makeTarGz({
      'llama-b10441/llama-server': { data: 'S' },
      'llama-b10441/libllama.dylib': { type: '2', link: '../OUTSIDE-SECRET.txt' },
    });
    const dest = path.join(work, 'out');
    await expect(extractTarGz(tar, dest)).rejects.toThrow(/ARCHIVE_UNSAFE_ENTRY/);
    expect(existsSync(path.join(dest, 'libllama.dylib'))).toBe(false);
  });

  it('refuses a hard link written THROUGH a directory symlink, which plants a real file outside', async () => {
    // The reviewer's archive, reproduced: a directory symlink that escapes the
    // staging tree, then a hard link placed under it. Both members pass
    // `safeEntryPath` - it is lexical, and `d/.profile` still looks inside -
    // so the copy in pass 2 travels through the live link and writes a REGULAR
    // file outside the destination, with the extraction reporting success.
    const outside = path.join(work, 'OUTSIDE');
    await mkdir(outside, { recursive: true });
    const tar = await makeTarGz({
      'llama-b10441/llama-server': { data: 'S' },
      'llama-b10441/payload': { data: '#!/bin/sh\necho PWNED\n' },
      'llama-b10441/d': { type: '2', link: '../OUTSIDE' },
      'llama-b10441/d/.profile': { type: '1', link: 'llama-b10441/payload' },
    });
    await expect(extractTarGz(tar, path.join(work, 'out'))).rejects.toThrow(/ARCHIVE_UNSAFE_ENTRY/);
    expect(existsSync(path.join(outside, '.profile'))).toBe(false);
  });

  it('refuses a member placed under a symlink even when both look contained', async () => {
    // `a -> .` and `a/x -> ../victim` are each inside the tree on their own:
    // `.` is the root, and `../victim` normalises to `victim` against `a`. On
    // disk `a` IS the root, so `a/x` is written at the root and its `..` leaves
    // the tree. Refusing to place anything under a link removes the class
    // rather than the instance.
    const tar = await makeTarGz({
      'llama-b10441/llama-server': { data: 'S' },
      'llama-b10441/victim': { data: 'REAL' },
      'llama-b10441/a': { type: '2', link: '.' },
      'llama-b10441/a/x': { type: '2', link: '../victim' },
    });
    await expect(extractTarGz(tar, path.join(work, 'out'))).rejects.toThrow(/ARCHIVE_UNSAFE_ENTRY/);
  });

  it('still materialises a relative target that climbs out of a subdirectory and back inside', async () => {
    // The containment rule is "inside the extraction root", not "no `..`".
    // llama.cpp's own chains are relative, and a link one directory down that
    // names a sibling of its parent is contained - it must keep working.
    const tar = await makeTarGz({
      'llama-b10441/libggml.0.20.0.dylib': { data: 'REAL GGML', mode: 0o755 },
      'llama-b10441/sub/libggml.dylib': { type: '2', link: '../libggml.0.20.0.dylib' },
    });
    const dest = path.join(work, 'out');
    const entries = await extractTarGz(tar, dest);
    expect(await readFile(path.join(dest, 'sub', 'libggml.dylib'), 'utf8')).toBe('REAL GGML');
    expect(entries.map((e) => e.relPath).toSorted()).toEqual(['libggml.0.20.0.dylib', 'sub/libggml.dylib']);
  });

  it('refuses a symlink whose target is not in the archive', async () => {
    const tar = await makeTarGz({
      'llama-b10441/llama-server': { data: 'S' },
      'llama-b10441/libllama.dylib': { type: '2', link: 'never-shipped.dylib' },
    });
    await expect(extractTarGz(tar, path.join(work, 'out'))).rejects.toThrow(/ARCHIVE_MALFORMED/);
  });

  it('refuses a symlink cycle instead of looping', async () => {
    const tar = await makeTarGz({
      'llama-b10441/llama-server': { data: 'S' },
      'llama-b10441/a.dylib': { type: '2', link: 'b.dylib' },
      'llama-b10441/b.dylib': { type: '2', link: 'a.dylib' },
    });
    await expect(extractTarGz(tar, path.join(work, 'out'))).rejects.toThrow(/ARCHIVE_MALFORMED/);
  });

  it('falls back to a copy when the platform will not create the symlink', async () => {
    // Windows without Developer Mode raises EPERM; a file already sitting at
    // the link path raises EEXIST. Extracting twice into the same directory
    // reproduces the second, and the contract has to hold either way: opening
    // the name a binary loads must yield the library's bytes.
    const tar = await makeTarGz(macosShape);
    const dest = path.join(work, 'out');
    await extractTarGz(tar, dest);
    const entries = await extractTarGz(tar, dest);

    expect(await readFile(path.join(dest, 'libllama.0.dylib'), 'utf8')).toBe('REAL LIBLLAMA');
    expect(await readFile(path.join(dest, 'libllama.dylib'), 'utf8')).toBe('REAL LIBLLAMA');
    expect(entries.filter((e) => e.kind === 'link')).toHaveLength(2);
  });

  it('creates directory members without counting them as files', async () => {
    const tar = await makeTarGz({
      'llama-b10441/': { type: '5' },
      'llama-b10441/llama-server': { data: 'S' },
    });
    const dest = path.join(work, 'out');
    const entries = await extractTarGz(tar, dest);
    expect(entries.map((e) => e.relPath)).toEqual(['llama-server']);
  });

  it('refuses a member type it cannot put on disk rather than skipping it', async () => {
    // '3' is a character device. Nothing llama.cpp ships - but dropping an
    // unknown type is exactly how the symlinks disappeared, so it must raise.
    const tar = await makeTarGz({
      'llama-b10441/llama-server': { data: 'S' },
      'llama-b10441/tty': { type: '3' },
    });
    await expect(extractTarGz(tar, path.join(work, 'out'))).rejects.toThrow(/ARCHIVE_UNSUPPORTED_ENTRY/);
  });

  it('honours a pax path override so a long name is not silently truncated', async () => {
    // pax records are `"<total-length> key=value\n"`, where the length counts
    // its own digits and the space.
    const long = `llama-b10441/renamed-${'x'.repeat(20)}.dylib`;
    const body = `path=${long}\n`;
    const record = `${String(body.length + 4).padStart(3, '0')} ${body}`;
    const tar = await makeTarGz({
      'llama-b10441/llama-server': { data: 'S' },
      'llama-b10441/PaxHeader': { type: 'x', data: record },
      'llama-b10441/placeholder.dylib': { data: 'LIB' },
    });
    const dest = path.join(work, 'out');
    const entries = await extractTarGz(tar, dest);
    expect(entries.map((e) => e.relPath).toSorted()).toEqual(
      [`renamed-${'x'.repeat(20)}.dylib`, 'llama-server'].toSorted()
    );
  });
});

describe('extractZip - symlink entries', () => {
  it('materialises a zip symlink instead of writing its target name as content', async () => {
    // A zip built on macOS/Linux marks a symlink with S_IFLNK in the high half
    // of its external attributes and stores the target as the payload.
    const zip = new JSZip();
    zip.file('libllama.0.1.0.dylib', 'REAL LIBLLAMA');
    zip.file('libllama.0.dylib', 'libllama.0.1.0.dylib', {
      unixPermissions: 0xa1ff, // S_IFLNK | 0777
    });
    const file = path.join(work, 'symlink.zip');
    await writeFile(file, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));

    const dest = path.join(work, 'out');
    const entries = await extractZip(file, dest);
    expect(await readFile(path.join(dest, 'libllama.0.dylib'), 'utf8')).toBe('REAL LIBLLAMA');
    expect(entries.find((e) => e.relPath === 'libllama.0.dylib').kind).toBe('link');
  });

  it('refuses a zip symlink whose relative target climbs out of the tree', async () => {
    // Same hole, reached through the other reader: a zip symlink stores its
    // target as the payload, so `../OUTSIDE-SECRET.txt` arrives as content and
    // was handed straight to symlink().
    await writeFile(path.join(work, 'OUTSIDE-SECRET.txt'), 'SECRET BYTES');
    const zip = new JSZip();
    zip.file('llama-server.exe', 'SERVER');
    zip.file('libllama.dylib', '../OUTSIDE-SECRET.txt', { unixPermissions: 0xa1ff });
    const file = path.join(work, 'escape.zip');
    await writeFile(file, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));

    const dest = path.join(work, 'out');
    await expect(extractZip(file, dest)).rejects.toThrow(/ARCHIVE_UNSAFE_ENTRY/);
    expect(existsSync(path.join(dest, 'libllama.dylib'))).toBe(false);
  });
});

describe('extractZip - zero-length members, which are legal zip', () => {
  it('extracts a stored zero-byte member instead of crashing on an empty byte range', async () => {
    // `end: start + compressedSize - 1` is `start - 1` for an empty member, and
    // Node rejects that range before reading a byte. One empty file anywhere in
    // a release zip therefore fails every install of that release, with a raw
    // RangeError surfacing as LLAMACPP_EXTRACT_FAILED and no way forward.
    const zip = await makeZip({ 'llama-server.exe': 'SERVER', 'empty.dll': '' }, { store: true });
    const dest = path.join(work, 'out');
    const entries = await extractZip(zip, dest);

    expect(entries.map((e) => e.relPath).toSorted()).toEqual(['empty.dll', 'llama-server.exe']);
    expect(await readFile(path.join(dest, 'empty.dll'))).toEqual(Buffer.alloc(0));
    expect(entries.find((e) => e.relPath === 'empty.dll').bytes).toBe(0);
    expect(await readFile(path.join(dest, 'llama-server.exe'), 'utf8')).toBe('SERVER');
  });

  it('extracts a deflated zero-byte member too', async () => {
    // JSZip writes compressedSize 0 for an empty member under DEFLATE as well,
    // so the deflate branch hits the same range.
    const zip = await makeZip({ 'llama-server.exe': 'SERVER', LICENSE: '' });
    const dest = path.join(work, 'out');
    const entries = await extractZip(zip, dest);

    expect(entries.map((e) => e.relPath).toSorted()).toEqual(['LICENSE', 'llama-server.exe']);
    expect(await readFile(path.join(dest, 'LICENSE'))).toEqual(Buffer.alloc(0));
  });

  it('reports a zero-length symlink member as a typed archive error, not a RangeError', async () => {
    // A symlink entry with no payload names nothing. That is malformed, and the
    // module's contract is that malformed raises ArchiveError - not that the
    // stream constructor throws first with a message about "start".
    const zip = new JSZip();
    zip.file('llama-server.exe', 'SERVER');
    zip.file('libllama.dylib', '', { unixPermissions: 0xa1ff });
    const file = path.join(work, 'empty-link.zip');
    await writeFile(file, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));

    await expect(extractZip(file, path.join(work, 'out'))).rejects.toThrow(ArchiveError);
    await expect(extractZip(file, path.join(work, 'out2'))).rejects.toThrow(/ARCHIVE_MALFORMED/);
  });
});
