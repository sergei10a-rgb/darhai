/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dev directory scanner - walks ~/dev/ exactly 2 levels deep looking for
 * <dir1>/<dir2>/.ijfw/memory/ directories not already in the IJFW registry,
 * then imports their .md files into the current project memory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { parseMarkdownBlocks } from '../memory/markdownFrontmatter';
import log from 'electron-log';

export type DevMemoryCandidate = {
  path: string;
  projectName: string;
  memoryCount: number;
  alreadyInRegistry: boolean;
};

export type DevScanImportResult = {
  imported: number;
  skipped: number;
  projectsFound: number;
  errors: string[];
};

// ===== Registry reader =====

async function readRegistryPaths(): Promise<Set<string>> {
  const registryPath = path.join(os.homedir(), '.ijfw', 'registry.md');
  const known = new Set<string>();
  try {
    const content = await fs.promises.readFile(registryPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
      const parts = trimmed.split('|').map((p) => p.trim());
      if (parts[0]) known.add(path.resolve(parts[0]));
    }
  } catch {
    // Registry absent - all candidates are new.
  }
  return known;
}

// ===== Scanner =====

/**
 * Candidate dev roots to scan for IJFW projects. Includes the common per-user
 * dev folders plus, on Windows, drive-level roots (e.g. C:\claude). Roots that
 * do not exist are skipped silently by the scanner.
 */
function candidateDevRoots(): string[] {
  const home = os.homedir();
  const roots = new Set<string>();
  for (const name of ['dev', 'Dev', 'projects', 'Projects', 'code', 'Code', 'src', 'repos', 'workspace', 'work']) {
    roots.add(path.join(home, name));
  }
  if (process.platform === 'win32') {
    const drive = process.env.SystemDrive ? process.env.SystemDrive + path.sep : 'C:\\';
    for (const name of ['claude', 'dev', 'projects', 'code', 'src', 'work']) {
      roots.add(path.join(drive, name));
    }
  }
  return [...roots];
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Immediate non-hidden, non-symlink subdirectories of `parent`. */
async function childDirs(parent: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const full = path.join(parent, e.name);
    try {
      if ((await fs.promises.lstat(full)).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    out.push(full);
  }
  return out;
}

/**
 * Scan the candidate dev roots for `.ijfw/memory/` directories at depth 1 AND
 * depth 2 beneath each root - i.e. both `<root>/<proj>/.ijfw/memory` (projects
 * living directly under a root, e.g. C:\claude\darhai) and
 * `<root>/<group>/<proj>/.ijfw/memory` (grouped layouts). Deduplicates by
 * resolved project path so a project reachable via two roots is listed once.
 */
export async function scanForMemoryDirs(): Promise<DevMemoryCandidate[]> {
  const registryPaths = await readRegistryPaths();
  const seen = new Set<string>();
  const candidates: DevMemoryCandidate[] = [];

  async function consider(projectDir: string): Promise<void> {
    const resolved = path.resolve(projectDir);
    if (seen.has(resolved)) return;
    const memoryDir = path.join(projectDir, '.ijfw', 'memory');
    if (!(await isDir(memoryDir))) return;
    seen.add(resolved);

    let mdFiles: string[] = [];
    try {
      const memEntries = await fs.promises.readdir(memoryDir);
      mdFiles = memEntries.filter((n) => n.endsWith('.md'));
    } catch {
      // unreadable - still list as candidate
    }
    candidates.push({
      path: projectDir,
      projectName: path.basename(projectDir),
      memoryCount: mdFiles.length,
      alreadyInRegistry: registryPaths.has(resolved),
    });
  }

  for (const root of candidateDevRoots()) {
    if (!(await isDir(root))) continue;
    for (const dir1 of await childDirs(root)) {
      await consider(dir1); // depth 1: <root>/<proj>
      for (const dir2 of await childDirs(dir1)) {
        await consider(dir2); // depth 2: <root>/<group>/<proj>
      }
    }
  }

  return candidates;
}

// ===== Importer =====

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
 * Import .md files from the given project memory dirs into the current project memory.
 * `paths` is an array of project root paths (each must have a .ijfw/memory/ dir).
 */
export async function runDevScanImport(
  paths: string[],
  opts?: { ijfwMemoryDir?: string }
): Promise<DevScanImportResult> {
  const targetMemDir = opts?.ijfwMemoryDir ?? path.join(os.homedir(), '.ijfw', 'memory');
  const result: DevScanImportResult = { imported: 0, skipped: 0, projectsFound: 0, errors: [] };

  try {
    await fs.promises.mkdir(targetMemDir, { recursive: true });
  } catch (err) {
    result.errors.push(`Failed to create target memory dir: ${String(err)}`);
    return result;
  }

  for (const projectPath of paths) {
    const sourceMemDir = path.join(projectPath, '.ijfw', 'memory');
    try {
      await fs.promises.access(sourceMemDir);
    } catch {
      result.errors.push(`No .ijfw/memory at ${projectPath}`);
      continue;
    }

    result.projectsFound++;
    const projectName = path.basename(projectPath);

    let mdFiles: string[] = [];
    try {
      const entries = await fs.promises.readdir(sourceMemDir);
      mdFiles = entries.filter((n) => n.endsWith('.md'));
    } catch (err) {
      result.errors.push(`Cannot read ${sourceMemDir}: ${String(err)}`);
      continue;
    }

    for (const mdFile of mdFiles) {
      const filePath = path.join(sourceMemDir, mdFile);
      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const blocks = parseMarkdownBlocks(content);

        for (const block of blocks) {
          const fm = block.frontmatter;
          const summaryRaw = typeof fm['summary'] === 'string' ? fm['summary'] : '';
          const summary = summaryRaw || block.body.split('\n')[0].replace(/^#+\s*/, '') || 'Untitled';
          const storedRaw = typeof fm['stored'] === 'string' ? fm['stored'] : '';
          const storedAt = storedRaw ? Date.parse(storedRaw) || Date.now() : Date.now();

          // Derive a stable id from source + summary.
          const idSource = `${projectPath}:${mdFile}:${summary.slice(0, 80)}`;
          const id = crypto.createHash('sha1').update(idSource).digest('hex').slice(0, 12);

          const destFile = path.join(targetMemDir, `devscan-${id}.md`);

          try {
            await fs.promises.access(destFile);
            result.skipped++;
            continue;
          } catch {
            // File does not exist - write.
          }

          const rawTags = fm['tags'];
          const tags: string[] = Array.isArray(rawTags)
            ? rawTags
            : typeof rawTags === 'string' && rawTags
              ? [rawTags]
              : [];

          const typeRaw = typeof fm['type'] === 'string' ? fm['type'] : 'observation';

          const frontmatter = buildFrontmatter({
            type: typeRaw,
            summary: summary.replace(/[\r\n]+/g, ' ').slice(0, 200),
            stored: new Date(storedAt).toISOString(),
            project: projectName,
            tags,
            source: 'dev-scan',
            source_path: filePath.replace(/[\r\n]+/g, ' '),
          });

          await fs.promises.writeFile(destFile, `${frontmatter}\n${block.body}\n`, 'utf8');
          result.imported++;
        }
      } catch (err) {
        log.warn('[devScanImporter] failed to import file', { filePath, err });
        result.errors.push(`${filePath}: ${String(err)}`);
      }
    }
  }

  return result;
}
