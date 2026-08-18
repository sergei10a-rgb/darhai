/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Filesystem mechanics for the local spill store: a private (0700) session-scoped
 * directory, traversal-safe filename derivation, and an exclusive owner-only
 * write. Kept free of any policy/config object so the on-disk behavior is
 * unit-testable without a session, and reusable by whatever seam decides WHEN to
 * spill (see {@link spillText}).
 *
 * The security properties this file exists to guarantee, against a hostile local
 * user or a pre-planted path on a shared machine:
 *   - The default root is an UNPREDICTABLE 0700 dir (`mkdtemp`), so another user
 *     cannot guess it, pre-create a symlink inside it, or read spilled output.
 *   - Filenames combine a random hex prefix with a sanitized suggested name, so
 *     even inside a known root the exact path cannot be predicted and planted.
 *   - The write is `open('wx', 0o600)` - EXCLUSIVE (fails if the path already
 *     exists, symlink or not) and owner-only - so a pre-planted target can never
 *     redirect the write to a file the attacker controls.
 *   - Untrusted `sessionId` / `suggestedName` are neutralized to a single path
 *     segment before any filesystem use, so `../`, absolute paths, NUL, and
 *     separators cannot traverse out of the session directory.
 *
 * On Windows `0o700`/`0o600` are largely advisory (Node maps the write bit
 * only), but the load-bearing defenses - the unpredictable `mkdtemp` root, the
 * random filename, and the exclusive `wx` open - all hold cross-platform.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let defaultRoot: string | undefined;

/**
 * The default spill root: a private (0700) per-process directory under the OS
 * temp dir, created lazily on first use. A predictable, world-readable path would
 * let other local users read spilled tool output or pre-create symlinks;
 * `mkdtemp` yields an unpredictable suffix with 0700 semantics.
 *
 * @returns the lazily-created private spill root (absolute path).
 */
export function privateRoot(): string {
  defaultRoot ??= mkdtempSync(join(tmpdir(), 'darhai-spill-'));
  return defaultRoot;
}

/**
 * Encode an arbitrary string as ONE safe path segment, injectively over all JS
 * (UTF-16) strings. A session id or suggested name is untrusted, so this
 * neutralizes `../`, absolute paths, NUL, and separators before any filesystem
 * use. Each code unit is kept literal (`[A-Za-z0-9._-]`, minus `~`) or escaped as
 * `~XXXX`; `~` is itself escaped, so the mapping is reversible and distinct
 * inputs never collide. The whole-segment tokens `.`/`..` are escaped so they can
 * never traverse. The empty string encodes to `~` (never an empty segment).
 *
 * @param raw - the untrusted string to encode as one safe path segment.
 * @returns an injective, filesystem-safe single path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~';
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return out;
}

/**
 * The session-scoped directory: `<root>/session-<hash(sessionId)>`, a short
 * stable hash. Hashing (rather than embedding the raw id) keeps the directory
 * name bounded and opaque; a fixed 12 hex chars is ample to avoid collisions
 * within one process's sessions.
 *
 * @param root - the spill root directory.
 * @param sessionId - the owning session id, hashed into a stable directory name.
 * @returns the absolute session-scoped spill directory path.
 */
export function sessionDir(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
  return join(root, `session-${hash}`);
}

/** Options for {@link saveTextFile}. */
export interface SaveTextOptions {
  /** The spill root directory (configured, or the lazy private default). */
  root: string;
  /** The owning session id (scopes the directory). */
  sessionId: string;
  /** Caller-suggested base name; sanitized to one safe segment before use. */
  suggestedName: string;
  /** The full text to persist (UTF-8). */
  content: string;
}

/** A written spill file. */
export interface SavedText {
  /** Absolute path to the written file. */
  path: string;
  /** UTF-8 byte length of the written content. */
  bytes: number;
}

/**
 * Write `content` to a fresh file under the session-scoped directory and return
 * its path + byte length. The filename is a random hex prefix plus the sanitized
 * `suggestedName`, so it is unpredictable (defeats symlink planting in a shared
 * root) and still readable. The open is exclusive + owner-only (`'wx', 0o600`):
 * it FAILS on any pre-existing path - symlink or not - so a planted target cannot
 * redirect the write.
 *
 * @param options - the resolved root and request fields.
 * @returns the written file path and UTF-8 byte length.
 * @throws on a real storage failure (permissions, ENOSPC, a colliding path).
 */
export async function saveTextFile(options: SaveTextOptions): Promise<SavedText> {
  const dir = sessionDir(options.root, options.sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const safeName = encodeSegment(options.suggestedName);
  const path = join(dir, `${randomBytes(6).toString('hex')}-${safeName}`);
  const bytes = Buffer.byteLength(options.content, 'utf8');
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(options.content);
  } finally {
    await handle.close();
  }
  return { path, bytes };
}
