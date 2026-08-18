/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Obsidian vault importer.
 * Detects vaults under ~/Documents/ (max depth 4) by presence of .obsidian/
 * and imports all .md files as MemoryEntry observation records.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import log from 'electron-log';
import { globalMemoryDir } from '../memory/memoryRoots';
import { parseWikilinks } from '../wiki/wikilinkResolver';

export type VaultInfo = {
  path: string;
  name: string;
  mdFileCount: number;
};

export type ObsidianImportResult = {
  imported: number;
  skipped: number;
  errors: string[];
  /** Total .md files found in the vault (before any maxFiles cap). */
  total: number;
  /** True when the import was capped to `maxFiles` most-recent files. */
  capped: boolean;
};

export type ObsidianVaultPreview = {
  /** Number of .md files in the vault (bounded by PREVIEW_MAX_FILES). */
  mdCount: number;
  /** Sum of the .md files' sizes in bytes. */
  totalBytes: number;
};

/** Bound the preview walk so a pathological directory cannot stall the UI. */
const PREVIEW_MAX_FILES = 20_000;

/**
 * Unique [[wikilink]] target names carried into the generated frontmatter.
 * Capped so a hub note with hundreds of links keeps the frontmatter bounded.
 */
const MAX_FRONTMATTER_LINKS = 20;

// ===== Vault detection =====

async function countMdFiles(dir: string, excludeDir: string): Promise<number> {
  let count = 0;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && path.join(dir, entry.name) === excludeDir) continue;
      if (!entry.isDirectory() && entry.name.endsWith('.md')) {
        count++;
      }
    }
  } catch {
    // unreadable - return 0
  }
  return count;
}

async function scanForObsidianDirs(
  dir: string,
  currentDepth: number,
  maxDepth: number,
  results: VaultInfo[]
): Promise<void> {
  if (currentDepth > maxDepth) return;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const hasObsidian = entries.some((e) => e.isDirectory() && e.name === '.obsidian');
  if (hasObsidian) {
    const obsidianPath = path.join(dir, '.obsidian');
    const mdCount = await countMdFiles(dir, obsidianPath);
    results.push({
      path: dir,
      name: path.basename(dir),
      mdFileCount: mdCount,
    });
    // Don't recurse into vault - vaults don't nest.
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip hidden directories (except we already handle .obsidian above).
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    // Skip symlinks - don't follow them out of the scanned tree.
    try {
      const lstat = await fs.promises.lstat(fullPath);
      if (lstat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    await scanForObsidianDirs(fullPath, currentDepth + 1, maxDepth, results);
  }
}

/**
 * Scan ~/Documents/ (max depth 4) for Obsidian vaults.
 */
export async function detectVaults(): Promise<VaultInfo[]> {
  const docsDir = path.join(os.homedir(), 'Documents');
  const results: VaultInfo[] = [];
  try {
    await fs.promises.access(docsDir);
  } catch {
    return results;
  }
  await scanForObsidianDirs(docsDir, 0, 4, results);
  return results;
}

// ===== Importer =====

function entryId(relativePath: string): string {
  return crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 16);
}

function extractH1(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * A leading Obsidian `---…---` frontmatter fence, CRLF-tolerant. Shared by
 * detection, tag extraction and stripping so the three can never disagree
 * about whether a note "has frontmatter" (M3).
 */
const LEADING_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function parseFrontmatterTags(content: string): string[] {
  const match = content.match(LEADING_FRONTMATTER_RE);
  if (!match) return [];
  const fm = match[1];
  // Match `tags: [a, b]` or `tags:\n  - a\n  - b`
  const inlineMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  const blockLines = fm.match(/^tags:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (blockLines) {
    return blockLines[1]
      .split('\n')
      .map((l) => l.replace(/^\s+-\s+/, '').trim())
      .filter((t) => t.length > 0);
  }
  return [];
}

function stripFrontmatter(content: string): string {
  return content.replace(LEADING_FRONTMATTER_RE, '').trim();
}

/**
 * Unique [[wikilink]] target names from a note body, in order of first
 * appearance. Names are sanitized for the inline `[a, b]` frontmatter array
 * (commas/brackets/newlines would break the top-level comma split on re-read)
 * and the list is capped at MAX_FRONTMATTER_LINKS.
 */
export function extractWikilinkNames(body: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const link of parseWikilinks(body)) {
    const clean = link.name
      .replace(/[,[\]\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean.length === 0 || seen.has(clean)) continue;
    seen.add(clean);
    names.push(clean);
    if (names.length >= MAX_FRONTMATTER_LINKS) break;
  }
  return names;
}

/**
 * Expand a leading `~` (both `~/` POSIX and `~\` Windows) and resolve to an
 * absolute path. Shared by import and preview so the renderer never has to
 * pre-expand paths.
 */
export function expandVaultPath(rawVaultPath: string): string {
  let vaultPath = rawVaultPath;
  if (vaultPath === '~') {
    vaultPath = os.homedir();
  } else if (vaultPath.startsWith('~/') || vaultPath.startsWith('~' + path.sep)) {
    vaultPath = path.join(os.homedir(), vaultPath.slice(2));
  }
  return path.resolve(vaultPath);
}

function buildFrontmatter(fields: Record<string, string | string[] | number>): string {
  const lines = ['---'];
  for (const [key, val] of Object.entries(fields)) {
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.map((v) => String(v)).join(', ')}]`);
    } else {
      const escaped = String(val)
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 500);
      lines.push(`${key}: ${escaped}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * True when `child` resolves to `root` itself or a path nested beneath it.
 * Separator-aware via `path.relative` so it does not false-match a sibling
 * directory that shares a name prefix (e.g. `/vault` vs `/vault-evil`).
 */
function isInsideRoot(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Read a vault `.md` file while closing the TOCTOU window between the walk-time
 * symlink check and this read. An attacker who controls the vault dir can swap a
 * regular `.md` for a symlink in the race window; a naive `readFile` would
 * follow it out of the vault (e.g. to `~/.ssh/id_rsa`).
 *
 * Defenses, applied at read time against the live filesystem:
 *  1. Open with `O_NOFOLLOW` (where supported) so a symlink swapped in for the
 *     final component is refused atomically at `open()` (ELOOP), no follow.
 *  2. Re-resolve `fs.realpath` and assert the result is still inside the vault
 *     root - this also catches a symlinked *intermediate* directory component
 *     that `O_NOFOLLOW` (final-component only) would miss.
 *  3. `fstat` the opened descriptor and require a regular file, so a fifo/device
 *     swapped in is refused.
 *
 * Returns the file content, or `null` (with a warning) if any guard trips.
 */
export async function readConfinedVaultFile(filePath: string, vaultRoot: string): Promise<string | null> {
  // O_NOFOLLOW is POSIX-only; it is `undefined` on Windows. When absent we omit
  // it and rely on the realpath + fstat guards below, which are cross-platform.
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;

  // Canonicalize the vault root for the comparison so platforms whose tmp/home
  // dirs are themselves symlinks (e.g. macOS `/var` -> `/private/var`) do not
  // false-reject legitimate in-vault files. If the root cannot be resolved
  // (does not exist), fall back to its lexical form.
  let canonicalRoot = vaultRoot;
  try {
    canonicalRoot = await fs.promises.realpath(vaultRoot);
  } catch {
    // keep the lexical root
  }

  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);

    // Re-resolve the real path now (after open) and confirm it is still inside
    // the vault root. Catches a symlinked intermediate directory component.
    const real = await fs.promises.realpath(filePath);
    if (!isInsideRoot(canonicalRoot, real)) {
      log.warn('[obsidianImporter] skipping file that resolves outside vault root', {
        filePath,
        real,
        vaultRoot,
      });
      return null;
    }

    const st = await fd.stat();
    if (!st.isFile()) {
      log.warn('[obsidianImporter] skipping non-regular vault entry', { filePath });
      return null;
    }

    return await fd.readFile('utf8');
  } catch (err) {
    // ELOOP here means a symlink was swapped in for the final component and
    // O_NOFOLLOW refused to follow it - the TOCTOU attack, blocked.
    log.warn('[obsidianImporter] refused to read vault file', { filePath, err });
    return null;
  } finally {
    await fd?.close().catch(() => {});
  }
}

async function walkMdFiles(dir: string, skip: string[]): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      // Skip symlinks - don't follow them out of the vault tree.
      try {
        const lstat = await fs.promises.lstat(fullPath);
        if (lstat.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        if (skip.includes(fullPath) || entry.name.startsWith('.')) continue;
        const sub = await walkMdFiles(fullPath, skip);
        files.push(...sub);
      } else if (entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  } catch {
    // unreadable
  }
  return files;
}

/**
 * Count the .md notes of a vault and sum their byte size WITHOUT reading any
 * note body. Used by the renderer to show a preview ("N notes · X MB") before
 * the user commits to an import. Never throws; an unreadable/absent vault
 * previews as zero.
 */
export async function previewVault(rawVaultPath: string): Promise<ObsidianVaultPreview> {
  const vaultPath = expandVaultPath(rawVaultPath);
  const preview: ObsidianVaultPreview = { mdCount: 0, totalBytes: 0 };
  try {
    await fs.promises.access(vaultPath);
  } catch {
    return preview;
  }
  const skipDirs = [path.join(vaultPath, '.obsidian'), path.join(vaultPath, '.trash')];
  const mdFiles = await walkMdFiles(vaultPath, skipDirs);
  for (const filePath of mdFiles.slice(0, PREVIEW_MAX_FILES)) {
    preview.mdCount++;
    try {
      preview.totalBytes += (await fs.promises.stat(filePath)).size;
    } catch {
      // Unreadable size - still counted as a note.
    }
  }
  return preview;
}

/**
 * Import all .md files from an Obsidian vault into `ijfwMemoryDir`.
 */
export async function runObsidianImport(
  rawVaultPath: string,
  opts?: {
    ijfwMemoryDir?: string;
    maxFiles?: number;
    /** Called as files are processed (imported, skipped or errored). */
    onProgress?: (done: number, total: number) => void;
  }
): Promise<ObsidianImportResult> {
  // Expand tilde in main process (renderer must not pass unexpanded paths).
  const vaultPath = expandVaultPath(rawVaultPath);

  const memDir = opts?.ijfwMemoryDir ?? globalMemoryDir();
  const result: ObsidianImportResult = { imported: 0, skipped: 0, errors: [], total: 0, capped: false };

  try {
    await fs.promises.access(vaultPath);
  } catch {
    result.errors.push(`Vault not found: ${vaultPath}`);
    return result;
  }

  try {
    await fs.promises.mkdir(memDir, { recursive: true });
  } catch (err) {
    result.errors.push(`Failed to create memory dir: ${String(err)}`);
    return result;
  }

  const vaultName = path.basename(vaultPath);
  const skipDirs = [path.join(vaultPath, '.obsidian'), path.join(vaultPath, '.trash')];

  let mdFiles: string[];
  try {
    mdFiles = await walkMdFiles(vaultPath, skipDirs);
  } catch (err) {
    result.errors.push(`Failed to walk vault: ${String(err)}`);
    return result;
  }

  result.total = mdFiles.length;

  // Cap huge vaults (e.g. a session archive with tens of thousands of notes) to
  // the most-recently-modified `maxFiles` so the import stays bounded and the
  // memory store is not flooded. Only stat when a cap is actually needed.
  const maxFiles = opts?.maxFiles;
  if (typeof maxFiles === 'number' && maxFiles > 0 && mdFiles.length > maxFiles) {
    const withMtime: Array<{ p: string; m: number }> = [];
    for (const p of mdFiles) {
      let m = 0;
      try {
        m = (await fs.promises.stat(p)).mtimeMs;
      } catch {
        // unreadable - treat as oldest.
      }
      withMtime.push({ p, m });
    }
    withMtime.sort((a, b) => b.m - a.m);
    mdFiles = withMtime.slice(0, maxFiles).map((x) => x.p);
    result.capped = true;
  }

  // Progress is reported on every path through the loop (imported, deduped,
  // guarded or errored) so the renderer's counter always reaches the total.
  const totalToProcess = mdFiles.length;
  let processed = 0;
  const reportProgress = (): void => {
    processed++;
    if (processed % 25 === 0 || processed === totalToProcess) {
      opts?.onProgress?.(processed, totalToProcess);
    }
  };

  for (const filePath of mdFiles) {
    try {
      const relativePath = path.relative(vaultPath, filePath);
      const id = entryId(relativePath);

      const destFile = path.join(memDir, `obsidian-${id}.md`);

      // Dedupe: if file already exists, skip.
      try {
        await fs.promises.access(destFile);
        result.skipped++;
        continue;
      } catch {
        // File does not exist - proceed.
      }

      // Re-validate the file against the vault root at read time to close the
      // TOCTOU window between the walk-time lstat and this read (RT-B5-01).
      const rawContent = await readConfinedVaultFile(filePath, vaultPath);
      if (rawContent === null) {
        result.skipped++;
        continue;
      }
      const tags = parseFrontmatterTags(rawContent);
      const bodyOnly = stripFrontmatter(rawContent);
      const h1 = extractH1(bodyOnly);
      const summary = h1 ?? bodyOnly.slice(0, 280).replace(/\n/g, ' ');
      const links = extractWikilinkNames(bodyOnly);

      const stat = await fs.promises.stat(filePath);
      const storedAt = stat.mtimeMs;

      const fields: Record<string, string | string[] | number> = {
        type: 'observation',
        summary: summary.replace(/[\r\n]+/g, ' ').slice(0, 200),
        stored: new Date(storedAt).toISOString(),
        project: vaultName,
        tags,
        source: 'obsidian',
        source_path: relativePath.replace(/[\r\n]+/g, ' '),
      };
      // [[Wikilink]] targets keep the vault's link graph queryable after import
      // (Darhai's wiki layer resolves the same [[...]] syntax).
      if (links.length > 0) fields.links = links;
      const frontmatter = buildFrontmatter(fields);

      // Write the BODY only when the note carries its own frontmatter (M3):
      // writing rawContent verbatim used to produce a double `---…---` fence,
      // which parseMarkdownBlocks splits into a phantom empty-body entry plus
      // a second block wearing the note's own frontmatter. The note's tags are
      // already merged into the generated frontmatter above.
      const noteBody = LEADING_FRONTMATTER_RE.test(rawContent) ? bodyOnly : rawContent;
      const fileContent = `${frontmatter}\n${noteBody}\n`;
      await fs.promises.writeFile(destFile, fileContent, 'utf8');
      result.imported++;
    } catch (err) {
      log.warn('[obsidianImporter] failed to import file', { filePath, err });
      result.errors.push(`${filePath}: ${String(err)}`);
    } finally {
      reportProgress();
    }
  }

  return result;
}
