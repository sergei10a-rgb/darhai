/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Import service for Claude Code's native memory files.
 *
 * Claude Code stores durable memories as markdown files under
 *   ~/.claude/projects/<project>/memory/*.md
 * (one fact per file, with `name` / `description` / `metadata.type` frontmatter),
 * plus a MEMORY.md index. This is distinct from the third-party `claude-mem`
 * SQLite tool handled by claudeMemImporter.ts.
 *
 * This importer walks every project's memory directory and maps each memory
 * file to an IJFW MemoryEntry markdown record. It returns early (no throw) when
 * ~/.claude/projects is absent.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import log from 'electron-log';

export type ClaudeNativeImportResult = {
  imported: number;
  skipped: number;
  errors: string[];
};

/** The index file is a list of pointers, not a fact - skip it. */
const INDEX_FILENAME = 'MEMORY.md';

function extractFrontmatterField(content: string, field: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = match[1];
  const line = fm.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return line ? line[1].trim().replace(/^["']|["']$/g, '') : null;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
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
 * Locate every `<project>/memory` directory under `projectsRoot`
 * (default ~/.claude/projects). Returns absolute directory paths paired with
 * their project name.
 */
async function findClaudeMemoryDirs(projectsRoot: string): Promise<Array<{ dir: string; project: string }>> {
  const out: Array<{ dir: string; project: string }> = [];

  let projectDirs: fs.Dirent[];
  try {
    projectDirs = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return out; // ~/.claude/projects absent - nothing to import.
  }

  for (const entry of projectDirs) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const memoryDir = path.join(projectsRoot, entry.name, 'memory');
    try {
      const st = await fs.promises.stat(memoryDir);
      if (st.isDirectory()) out.push({ dir: memoryDir, project: entry.name });
    } catch {
      // no memory dir for this project - skip.
    }
  }
  return out;
}

/**
 * Import Claude Code native memory files into `ijfwMemoryDir`.
 */
export async function runClaudeNativeImport(opts?: {
  ijfwMemoryDir?: string;
  /** Override the Claude projects root (defaults to ~/.claude/projects). For tests. */
  projectsRoot?: string;
}): Promise<ClaudeNativeImportResult> {
  const memDir = opts?.ijfwMemoryDir ?? path.join(os.homedir(), '.ijfw', 'memory');
  const projectsRoot = opts?.projectsRoot ?? path.join(os.homedir(), '.claude', 'projects');
  const result: ClaudeNativeImportResult = { imported: 0, skipped: 0, errors: [] };

  const memoryDirs = await findClaudeMemoryDirs(projectsRoot);
  if (memoryDirs.length === 0) {
    result.errors.push('No Claude Code memory found under ~/.claude/projects');
    return result;
  }

  try {
    await fs.promises.mkdir(memDir, { recursive: true });
  } catch (err) {
    result.errors.push(`Failed to create memory dir: ${String(err)}`);
    return result;
  }

  const resolvedMemDir = path.resolve(memDir);

  for (const { dir, project } of memoryDirs) {
    let files: string[];
    try {
      const entries = await fs.promises.readdir(dir);
      files = entries.filter((n) => n.endsWith('.md') && n !== INDEX_FILENAME);
    } catch (err) {
      result.errors.push(`Cannot read ${dir}: ${String(err)}`);
      continue;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const raw = await fs.promises.readFile(filePath, 'utf8');

        // Stable id from project + filename so re-imports dedupe.
        const id = crypto.createHash('sha1').update(`${project}:${file}`).digest('hex').slice(0, 12);
        const destFile = path.join(memDir, `claude-${id}.md`);
        // Guard against path escape via a hostile id (defensive; id is a hash).
        if (!path.resolve(destFile).startsWith(resolvedMemDir + path.sep)) {
          result.errors.push(`${file}: resolved path escapes memDir - skipped`);
          continue;
        }

        try {
          await fs.promises.access(destFile);
          result.skipped++;
          continue;
        } catch {
          // does not exist - proceed to write.
        }

        const name = extractFrontmatterField(raw, 'name');
        const description = extractFrontmatterField(raw, 'description');
        const memType = extractFrontmatterField(raw, 'type'); // metadata.type line
        const body = stripFrontmatter(raw);
        const firstLine = body
          .split('\n')
          .find((l) => l.trim().length > 0)
          ?.replace(/^#+\s*/, '');
        const summary = description || name || firstLine || file.replace(/\.md$/, '');

        const stat = await fs.promises.stat(filePath);
        const tags = memType ? [memType] : [];

        const frontmatter = buildFrontmatter({
          type: 'observation',
          summary: summary.replace(/[\r\n]+/g, ' ').slice(0, 200),
          stored: new Date(stat.mtimeMs).toISOString(),
          project,
          tags,
          source: 'claude-code',
          source_file: file,
        });

        await fs.promises.writeFile(destFile, `${frontmatter}\n${body}\n`, 'utf8');
        result.imported++;
      } catch (err) {
        log.warn('[claudeNativeImporter] failed to import file', { filePath, err });
        result.errors.push(`${filePath}: ${String(err)}`);
      }
    }
  }

  return result;
}
