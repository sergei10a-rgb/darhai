/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared archive-entry vocabulary, the path-safety guard both readers use, and
 * the link materialiser that keeps SONAME/`@rpath` names on disk.
 *
 * The guard is the security boundary of the provisioner: an archive fetched
 * over the network gets to name the files it writes, so an entry called
 * `../../../.bashrc` or `C:\Windows\System32\evil.dll` must be refused before
 * anything is opened for writing. Both readers call {@link safeEntryPath} for
 * every entry and neither has a code path that writes without it.
 *
 * A link needs a second guard, because `safeEntryPath` is lexical and a link
 * changes what a path means. It answers where a member is PLACED; where a link
 * POINTS is checked in `linkTargetRelPath`, and whether a member is placed
 * under a link at all in `assertNoMemberUnderLink`. Both run before anything is
 * linked. Without them an archive could name `d -> ../../HOME` and then write
 * `d/.profile` through it - a real file outside the destination, produced by an
 * extraction that reported success. The sha256 check upstream is not an
 * independent guard here: the digest comes from the same API that served the
 * bytes, so a compromised release or a MITM'd download supplies both.
 *
 * Links are not decoration. MEASURED on the real b10441 release: the
 * macos-arm64 tarball is 62 members - 43 regular files, 18 symlinks, 1
 * directory - and the ubuntu-x64 tarball is 63 members with 10 symlinks. Every
 * name a shipped binary actually loads (`@rpath/libllama.0.dylib`,
 * `libggml-base.so.0`) is one of those symlinks; the regular files carry the
 * fully-versioned names (`libllama.0.1.0.dylib`, `libggml-base.so.0.20.0`)
 * that nothing links against. Dropping links therefore produces a directory
 * full of libraries that no loader can find.
 */

import fs from 'node:fs';
import { copyFile, mkdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';

/** One member of an archive, after prefix stripping. */
export type ArchiveEntry = {
  /** Archive-relative path with `/` separators, root prefix already stripped. */
  relPath: string;
  bytes: number;
  /** POSIX mode bits, or null when the container carries none (zip on Windows). */
  mode: number | null;
  /** `file` for a member with its own payload, `link` for one that aliases another. */
  kind: 'file' | 'link';
  /** For `link`, the name the archive pointed at; null for `file`. */
  linkTarget: string | null;
};

/**
 * A link member, before it is put on disk.
 *
 * `hard` distinguishes the two tar flavours: a hard link (typeflag `1`) names
 * its target relative to the archive root, a symlink (typeflag `2`) relative to
 * its own directory.
 */
export type ArchiveLink = {
  relPath: string;
  target: string;
  hard: boolean;
  mode: number | null;
};

/** Raised when an archive is malformed, unsafe, or uses something unsupported. */
export class ArchiveError extends Error {
  constructor(
    public readonly code:
      | 'ARCHIVE_UNSAFE_ENTRY'
      | 'ARCHIVE_MALFORMED'
      | 'ARCHIVE_UNSUPPORTED_METHOD'
      | 'ARCHIVE_UNSUPPORTED_ENTRY'
      | 'ARCHIVE_INCOMPLETE',
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'ArchiveError';
  }
}

/**
 * Resolve an archive-relative path under `destDir`, or throw.
 *
 * Refuses absolute paths (POSIX `/x` and Windows `C:\x` / `\\server\share`),
 * any `..` segment, and anything that escapes `destDir` after resolution.
 */
export function safeEntryPath(destDir: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.length === 0) {
    throw new ArchiveError('ARCHIVE_UNSAFE_ENTRY', 'empty entry name');
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('//')) {
    throw new ArchiveError('ARCHIVE_UNSAFE_ENTRY', `absolute path in archive: ${relPath}`);
  }
  if (normalized.split('/').includes('..')) {
    throw new ArchiveError('ARCHIVE_UNSAFE_ENTRY', `parent traversal in archive: ${relPath}`);
  }
  const root = path.resolve(destDir);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ArchiveError('ARCHIVE_UNSAFE_ENTRY', `entry escapes destination: ${relPath}`);
  }
  return resolved;
}

/**
 * The single top-level directory every entry shares, or null when there is none.
 *
 * Measured layouts differ by platform and this removes the difference instead of
 * hard-coding it: `llama-b10437-bin-ubuntu-x64.tar.gz` puts everything under
 * `llama-b10437/`, while `llama-b10437-bin-win-cpu-x64.zip` is flat (51 entries
 * at the root). Detecting the prefix means an upstream layout change degrades to
 * "no strip" rather than to a wrong path.
 */
export function commonRootPrefix(relPaths: readonly string[]): string | null {
  if (relPaths.length === 0) return null;
  let root: string | null = null;
  for (const p of relPaths) {
    const raw = p.replace(/\\/g, '/');
    const isDirEntry = raw.endsWith('/');
    const normalized = raw.replace(/\/+$/, '');
    if (normalized.length === 0) continue;
    const slash = normalized.indexOf('/');
    let head: string;
    if (slash === 0) return null; // absolute path: not a relative tree
    if (slash < 0) {
      // No inner slash. A bare *directory* entry ("llama-b10437/") is the root
      // itself and is consistent with stripping it; producers emit one (JSZip
      // does, and so do the real tarballs). A bare *file* at this level means
      // the archive is flat, so there is nothing to strip.
      if (!isDirEntry) return null;
      head = normalized;
    } else {
      head = normalized.slice(0, slash);
    }
    if (root === null) root = head;
    else if (root !== head) return null;
  }
  return root;
}

/** Drop a detected root prefix from an entry path. Returns null for the root dir itself. */
export function stripRoot(relPath: string, root: string | null): string | null {
  const normalized = relPath.replace(/\\/g, '/');
  if (!root) return normalized;
  const withSlash = `${root}/`;
  if (normalized === root || normalized === withSlash) return null;
  if (!normalized.startsWith(withSlash)) return normalized;
  const rest = normalized.slice(withSlash.length);
  return rest.length > 0 ? rest : null;
}

/** Longest chain of links an archive may ask us to follow before we call it a cycle. */
const MAX_LINK_HOPS = 16;

/**
 * Where a link points, expressed as an archive-relative path.
 *
 * Containment is decided HERE, not only in {@link safeEntryPath}, because that
 * guard answers where a link is PLACED and says nothing about where it POINTS.
 * Rejecting only an absolute target leaves `..` wide open: a symlink resolves
 * against its own directory the moment it exists on disk, so `d -> ../../HOME`
 * is a live door out of the tree, and every later member written under `d/`
 * travels through it. `safeEntryPath` cannot see that - it is purely lexical,
 * and `d/x` still looks inside.
 *
 * The rule is the one the real archives need: a target may name anything INSIDE
 * the extraction root and nothing outside it. Measured on b10441, every symlink
 * in both tarballs is a bare sibling name (`libggml.dylib -> libggml.0.dylib`),
 * and a relative hop that climbs out of a subdirectory back into the root stays
 * allowed - this is "inside the root", not "no `..`".
 */
function linkTargetRelPath(link: ArchiveLink): string {
  const target = link.target.replace(/\\/g, '/');
  if (target.length === 0) {
    throw new ArchiveError('ARCHIVE_MALFORMED', `link ${link.relPath} has an empty target`);
  }
  if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) {
    throw new ArchiveError('ARCHIVE_UNSAFE_ENTRY', `link ${link.relPath} points outside the archive: ${link.target}`);
  }
  // A hard link names its target from the archive root; a symlink from its own
  // directory. Measured: every symlink in the b10441 tarballs is a bare sibling
  // name, so this only ever collapses to the same directory in practice.
  const base = link.hard ? '.' : path.posix.dirname(link.relPath);
  const resolved = path.posix.normalize(path.posix.join(base, target));
  if (resolved === '..' || resolved.startsWith('../')) {
    throw new ArchiveError('ARCHIVE_UNSAFE_ENTRY', `link ${link.relPath} points outside the archive: ${link.target}`);
  }
  return resolved;
}

/** Every proper directory prefix of an archive-relative path, outermost first. */
function ancestorPaths(relPath: string): string[] {
  const parts = relPath.split('/').filter((s) => s.length > 0);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/**
 * Refuse an archive that places any member under one of its own links.
 *
 * Target containment alone is not enough, because two individually-contained
 * links compose into an escape: `a -> .` is the root, and `a/x -> ../victim`
 * normalises to `victim` against `a`, so both pass. On disk `a` IS the root, so
 * `a/x` is written at the root and its `..` leaves the tree. Any lexical guard
 * has the same blind spot - a path only means what it says while no ancestor of
 * it is a symlink.
 *
 * Removing the precondition removes the whole class. Nothing is lost: measured
 * on b10441, all 18 macos-arm64 and 10 ubuntu-x64 symlinks are leaf siblings in
 * the root directory and no member is placed under any of them. Regular files
 * need no check here because both readers write every one of them before
 * calling this, so no file can pass through a link that does not exist yet.
 */
function assertNoMemberUnderLink(links: readonly ArchiveLink[]): void {
  const linkPaths = new Set(links.map((l) => l.relPath.replace(/\\/g, '/')));
  for (const link of links) {
    for (const ancestor of ancestorPaths(link.relPath.replace(/\\/g, '/'))) {
      if (linkPaths.has(ancestor)) {
        throw new ArchiveError(
          'ARCHIVE_UNSAFE_ENTRY',
          `${link.relPath} is placed under the link ${ancestor}, which decides where it really lands`
        );
      }
    }
  }
}

/**
 * Put link members on disk, and return them as entries.
 *
 * A real symlink is written when the platform allows one, because that is what
 * the archive described. Windows refuses `symlink()` without Developer Mode or
 * elevation (EPERM), so anything that did not end up resolvable is replaced by
 * a copy of the file at the end of its chain. Both outcomes satisfy the only
 * property that matters downstream: opening `<install>/libggml-base.so.0`
 * yields the bytes of `libggml-base.so.0.20.0`.
 *
 * Chains are resolved rather than assumed one deep: the macOS tarball ships
 * `libggml.dylib -> libggml.0.dylib -> libggml.0.20.0.dylib`.
 */
export async function materializeLinks(destDir: string, links: readonly ArchiveLink[]): Promise<ArchiveEntry[]> {
  // Both checks run to completion before a single link exists on disk. That
  // ordering is the point: an escaping link is not a bad file to clean up
  // afterwards, it is a door the rest of the archive then walks through.
  assertNoMemberUnderLink(links);
  const targets = new Map<string, string>();
  for (const link of links) targets.set(link.relPath, linkTargetRelPath(link));

  // Pass 1: ask the platform for real symlinks. Ordering does not matter - a
  // symlink may dangle until the member it points at is written.
  const created = new Set<string>();
  for (const link of links) {
    const at = safeEntryPath(destDir, link.relPath);
    await mkdir(path.dirname(at), { recursive: true });
    if (link.hard) continue;
    try {
      await symlink(link.target.replace(/\\/g, '/'), at);
      created.add(link.relPath);
    } catch {
      // Falls through to the copy below. Windows without Developer Mode is the
      // expected case; a stale file left by an earlier run is the other.
    }
  }

  // Pass 2: anything that does not resolve to real bytes becomes a copy.
  const entries: ArchiveEntry[] = [];
  for (const link of links) {
    const at = safeEntryPath(destDir, link.relPath);
    if (!created.has(link.relPath) || !fs.existsSync(at)) {
      const resolved = resolveLinkChain(link.relPath, targets);
      const from = safeEntryPath(destDir, resolved);
      if (!fs.existsSync(from)) {
        throw new ArchiveError('ARCHIVE_MALFORMED', `link ${link.relPath} points at missing member ${resolved}`);
      }
      await copyFile(from, at);
    }
    // `stat` follows the link, so this is the size a reader will actually see
    // whichever branch produced the entry.
    const size = await stat(at);
    entries.push({ relPath: link.relPath, bytes: size.size, mode: link.mode, kind: 'link', linkTarget: link.target });
  }
  return entries;
}

/** Follow a link through other links until it names a real member. */
function resolveLinkChain(start: string, targets: ReadonlyMap<string, string>): string {
  let current = targets.get(start);
  if (current === undefined) throw new ArchiveError('ARCHIVE_MALFORMED', `no target recorded for link ${start}`);
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    const next = targets.get(current);
    if (next === undefined) return current;
    current = next;
  }
  throw new ArchiveError('ARCHIVE_MALFORMED', `link ${start} does not terminate within ${MAX_LINK_HOPS} hops`);
}

/**
 * Refuse an extraction that wrote fewer files than the archive declared.
 *
 * This is the invariant that makes a silent drop impossible. `declared` is
 * counted from the container's own manifest - tar headers, zip central
 * directory - before any filtering, so a reader that stops handling some member
 * type fails loudly here instead of producing a smaller, plausible-looking
 * install that everything downstream then certifies.
 */
export function assertComplete(written: readonly ArchiveEntry[], declared: number, what: string): void {
  if (written.length !== declared) {
    throw new ArchiveError(
      'ARCHIVE_INCOMPLETE',
      `${what}: archive declares ${declared} member(s) but ${written.length} landed on disk`
    );
  }
}
