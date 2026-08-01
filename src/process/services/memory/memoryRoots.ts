/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Resolution and bootstrap of the on-disk roots the memory index reads.
 *
 * Historically the index only ever read project roots listed in
 * `~/.ijfw/registry.md` - a file nothing in Darhai ever wrote - while every
 * user-facing write path (quick-add, drag-drop ingest, the importers, the
 * auto-extractor) wrote into `~/.ijfw/memory/`. That directory was never a
 * root, so memory was write-only: saves succeeded, nothing was ever recallable.
 *
 * The home-scoped root is therefore a first-class root here, always present and
 * created by the app itself, and the registry is bootstrapped by Darhai rather
 * than hand-written by the user.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Project name reported for the home-scoped root. Entries written with
 * `scope: 'global'` land here, and the Memory panel's "global" filter matches it.
 */
export const GLOBAL_PROJECT_NAME = 'global';

/**
 * Upper bound on markdown files read from one memory directory per index pass.
 * An Obsidian import can deposit thousands of files; this bounds the read/parse
 * budget of a single build without silently capping normal corpora.
 */
export const MAX_MEMORY_FILES_PER_ROOT = 5000;

const REGISTRY_HEADER = [
  '<!-- ijfw-registry: v1 -->',
  '<!-- Managed by Darhai. One project per line: <path> | <hash> | <ISO8601> -->',
  '',
].join('\n');

export type MemoryRoot = {
  /** Directory that owns the `.ijfw` tree (the IJFW home for the global root). */
  projectPath: string;
  /** Name entries are tagged with, and the key the project filter uses. */
  projectName: string;
  /** Directory holding this root's markdown memory files. */
  memoryDir: string;
  /** True for the home-scoped root that global writes target. */
  isGlobal: boolean;
  /** Registry `lastSeen` timestamp, 0 when unknown. */
  lastSeen: number;
};

/**
 * Home directory that owns the `.ijfw` tree. `DARHAI_IJFW_HOME` redirects the
 * whole subsystem at a different root, which lets tests exercise the real code
 * paths without touching (or polluting) the user's own memory store.
 */
export function ijfwHomeDir(): string {
  const override = process.env.DARHAI_IJFW_HOME?.trim();
  return override ? path.resolve(override) : os.homedir();
}

export function ijfwDir(): string {
  return path.join(ijfwHomeDir(), '.ijfw');
}

/** Directory global-scope writes target, and the home-scoped root's memory dir. */
export function globalMemoryDir(): string {
  return path.join(ijfwDir(), 'memory');
}

export function registryPath(): string {
  return path.join(ijfwDir(), 'registry.md');
}

type RegistryEntry = { path: string; lastSeen: number };

function parseDateToMs(stored: string): number {
  if (!stored) return 0;
  const ms = Date.parse(stored);
  return isNaN(ms) ? 0 : ms;
}

/** Read the registry file. Missing/unreadable registry means "no projects yet". */
export async function readRegistry(): Promise<RegistryEntry[]> {
  try {
    const content = await fs.promises.readFile(registryPath(), 'utf8');
    const entries: RegistryEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
      // Format: <path> | <hash> | <ISO8601>
      const parts = trimmed.split('|').map((p) => p.trim());
      if (parts.length < 1 || !parts[0]) continue;
      entries.push({ path: parts[0], lastSeen: parts[2] ? parseDateToMs(parts[2]) : 0 });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Create `<ijfw home>/.ijfw/memory` and an empty `registry.md` when they are
 * absent. Never truncates an existing registry - `wx` fails if the file is
 * already there, and that failure is the success case.
 */
export async function ensureIjfwBootstrap(): Promise<void> {
  await fs.promises.mkdir(globalMemoryDir(), { recursive: true });
  try {
    await fs.promises.writeFile(registryPath(), REGISTRY_HEADER, { encoding: 'utf8', flag: 'wx' });
  } catch {
    // Already exists (the common case) or is not writable - either way the
    // registry the user has must be left exactly as it is.
  }
}

/**
 * Append a project to the registry so its `.ijfw/memory` becomes an indexed
 * root. Idempotent: an already-registered path is left untouched.
 */
export async function registerProject(projectPath: string): Promise<boolean> {
  const resolved = path.resolve(projectPath);
  try {
    await fs.promises.access(path.join(resolved, '.ijfw', 'memory'));
  } catch {
    return false;
  }
  await ensureIjfwBootstrap();
  const existing = await readRegistry();
  if (existing.some((e) => path.resolve(e.path) === resolved)) return false;
  const line = `${resolved} | - | ${new Date().toISOString()}\n`;
  await fs.promises.appendFile(registryPath(), line, 'utf8');
  return true;
}

/** Legacy discovery for installs that predate registry bootstrap. */
async function fallbackScanForProjects(): Promise<RegistryEntry[]> {
  const devDir = path.join(ijfwHomeDir(), 'dev');
  const entries: RegistryEntry[] = [];
  try {
    for (const name of await fs.promises.readdir(devDir)) {
      const candidate = path.join(devDir, name);
      try {
        await fs.promises.access(path.join(candidate, '.ijfw', 'memory'));
        entries.push({ path: candidate, lastSeen: 0 });
      } catch {
        // not an IJFW project
      }
    }
  } catch {
    // dev dir doesn't exist
  }
  return entries;
}

/**
 * Every root the index should read: the home-scoped root first (always, and
 * created if missing), then each registered project that still has a memory
 * directory.
 */
export async function resolveMemoryRoots(): Promise<MemoryRoot[]> {
  await ensureIjfwBootstrap();

  const roots: MemoryRoot[] = [
    {
      projectPath: ijfwHomeDir(),
      projectName: GLOBAL_PROJECT_NAME,
      memoryDir: globalMemoryDir(),
      isGlobal: true,
      lastSeen: 0,
    },
  ];

  let registryEntries = await readRegistry();
  if (registryEntries.length === 0) registryEntries = await fallbackScanForProjects();

  const seen = new Set<string>([path.resolve(ijfwHomeDir())]);
  for (const entry of registryEntries) {
    const norm = path.resolve(entry.path);
    if (seen.has(norm)) continue;
    // Registry entries are user/tooling supplied: a stale line pointing at a
    // scratch dir must not populate the archive with junk.
    if (norm.includes('/tmp/') || norm.includes('Temp/')) continue;
    const memoryDir = path.join(norm, '.ijfw', 'memory');
    try {
      await fs.promises.access(memoryDir);
    } catch {
      continue;
    }
    seen.add(norm);
    roots.push({
      projectPath: norm,
      projectName: path.basename(norm),
      memoryDir,
      isGlobal: false,
      lastSeen: entry.lastSeen,
    });
  }

  return roots;
}

/**
 * Markdown files in one memory directory.
 *
 * Every `.md` file counts, not a fixed six-name allowlist: the importers write
 * `dropped-*.md`, `observation-*.md`, `obsidian-*.md` and `devscan-*.md`, none
 * of which the allowlist covered, so everything they ingested was invisible.
 */
export async function listMemoryFiles(memoryDir: string): Promise<string[]> {
  try {
    const dirents = await fs.promises.readdir(memoryDir, { withFileTypes: true });
    return dirents
      .filter((d) => d.isFile() && d.name.endsWith('.md') && !d.name.startsWith('.'))
      .map((d) => d.name)
      .toSorted()
      .slice(0, MAX_MEMORY_FILES_PER_ROOT);
  } catch {
    return [];
  }
}
