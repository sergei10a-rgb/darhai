/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Import IPC bridge - registers the memory.import.* namespace handlers.
 * Delegates to the four W1a import services.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import log from 'electron-log';
import { z } from 'zod';
import { ipcBridge } from '@/common';
import { getIjfwArchiveService } from '@process/services/memory/ijfwArchiveService';
import { GLOBAL_PROJECT_NAME, globalMemoryDir, registerProject } from '@process/services/memory/memoryRoots';
import { runClaudeMemImport } from '@process/services/import/claudeMemImporter';
import { runClaudeNativeImport } from '@process/services/import/claudeNativeImporter';
import { runObsidianImport, detectVaults } from '@process/services/import/obsidianImporter';
import { detectConfiguredVaults, getConfiguredVaultPaths } from '@process/services/import/obsidianVaultConfig';
import { runDevScanImport, scanForMemoryDirs } from '@process/services/import/devScanImporter';
import {
  runDropFolderProcess,
  startDropFolderWatcher,
  getDropFolderStatus,
} from '@process/services/import/dropFolderWatcher';
import type { DropFolderWatcherHandle } from '@process/services/import/dropFolderWatcher';

// ── Schemas ──────────────────────────────────────────────────────────────────

const obsidianVaultSchema = z.object({ vaultPath: z.string().min(1).max(2048) });

const ingestFileItemSchema = z.object({
  name: z.string().min(1).max(255),
  content: z.string().max(500_000),
  scope: z.enum(['project', 'global']).optional(),
});

const ingestFilesSchema = z.object({
  files: z.array(ingestFileItemSchema).min(1).max(50),
});

/**
 * Cap for a single Obsidian vault import. A session-archive vault can hold tens
 * of thousands of notes; we import the most-recent N to keep the memory store
 * bounded. The renderer surfaces the cap when it applies.
 */
const OBSIDIAN_MAX_FILES = 2000;

/** Error notes that just mean "this source is not present" - not real failures. */
const ABSENT_SOURCE_NOTE = [/not found/i, /No Claude Code memory found/i];

// ── Drop folder watcher handle (singleton) ───────────────────────────────────

let _dropWatcherHandle: DropFolderWatcherHandle | null = null;

/**
 * Memory directory an import writes into. The home-scoped directory is a
 * first-class index root (see memoryRoots.ts), so everything written here is
 * recallable; a `project` scope resolves to the most recently active registered
 * project and falls back to the home root when there is none.
 */
async function resolveMemoryDir(scope: 'project' | 'global' = 'global'): Promise<string> {
  if (scope === 'project') {
    try {
      const projects = await getIjfwArchiveService().getProjects();
      const real = projects.find((p) => p.basename !== GLOBAL_PROJECT_NAME);
      if (real) return path.join(real.path, '.ijfw', 'memory');
    } catch (err) {
      log.warn('[import] project scope resolution failed, using global', { err });
    }
  }
  return globalMemoryDir();
}

/** Re-read the memory index so freshly imported files are immediately visible. */
async function refreshArchive(): Promise<void> {
  try {
    await getIjfwArchiveService().rebuildNow();
  } catch (err) {
    log.warn('[import] archive rebuild after import failed', { err });
  }
}

export function initImportBridge(): void {
  // ── claude importer (native memory + claude-mem DB) ──────────────────────
  // The "Claude" source imports from BOTH Claude Code's native memory files
  // (~/.claude/projects/*/memory/*.md - what most users actually have) and the
  // third-party claude-mem SQLite tool. Either may be legitimately absent; a
  // "source not present" note is filtered out so it is not shown as an error.
  ipcBridge.memory.import.claudeMem.provider(async () => {
    try {
      const memDir = await resolveMemoryDir();
      const nativeResult = await runClaudeNativeImport({ ijfwMemoryDir: memDir });
      const dbResult = await runClaudeMemImport({ ijfwMemoryDir: memDir });
      const imported = nativeResult.imported + dbResult.imported;
      const errors = [...nativeResult.errors, ...dbResult.errors].filter(
        (e) => !ABSENT_SOURCE_NOTE.some((rx) => rx.test(e))
      );
      log.info('[import] claude done', {
        nativeImported: nativeResult.imported,
        dbImported: dbResult.imported,
        errorCount: errors.length,
      });
      if (imported > 0) await refreshArchive();
      return { count: imported, errors };
    } catch (err) {
      log.error('[import] claude threw', { err });
      return { count: 0, errors: [String(err)] };
    }
  });

  // ── obsidian vault importer ──────────────────────────────────────────────
  ipcBridge.memory.import.obsidianVault.provider(async (args) => {
    const parsed = obsidianVaultSchema.safeParse(args);
    if (!parsed.success) {
      log.warn('[import] obsidianVault invalid args', { args });
      return { count: 0, errors: ['invalid args'] };
    }
    try {
      // Expand tilde and resolve to absolute path in main process
      let vaultPath = parsed.data.vaultPath;
      // Expand a leading `~`, matching both `~/` (POSIX) and `~\` (Windows)
      // and joining via path.join so separators stay platform-correct.
      if (vaultPath === '~') {
        vaultPath = os.homedir();
      } else if (vaultPath.startsWith('~/') || vaultPath.startsWith('~' + path.sep)) {
        vaultPath = path.join(os.homedir(), vaultPath.slice(2));
      }
      vaultPath = path.resolve(vaultPath);
      // Allow a vault inside the home dir subtree OR one Obsidian itself has
      // registered (obsidian.json), which the user may legitimately keep outside
      // home (e.g. C:\claude\Main memory). Any other path is rejected.
      const homeDir = os.homedir();
      const insideHome = vaultPath === homeDir || vaultPath.startsWith(homeDir + path.sep);
      if (!insideHome) {
        const configured = await getConfiguredVaultPaths();
        let real = vaultPath;
        try {
          real = await fs.promises.realpath(vaultPath);
        } catch {
          // keep lexical path
        }
        if (!configured.has(vaultPath) && !configured.has(real)) {
          log.warn('[import] obsidianVault path not allowed', { vaultPath });
          return {
            count: 0,
            errors: ['vault path must be within home directory or a configured Obsidian vault'],
          };
        }
      }
      const memDir = await resolveMemoryDir();
      const { imported, skipped, errors, total, capped } = await runObsidianImport(vaultPath, {
        ijfwMemoryDir: memDir,
        maxFiles: OBSIDIAN_MAX_FILES,
      });
      log.info('[import] obsidianVault done', {
        vaultPath,
        imported,
        skipped,
        total,
        capped,
        errorCount: errors.length,
      });
      if (imported > 0) await refreshArchive();
      return { count: imported, errors, total, capped };
    } catch (err) {
      log.error('[import] obsidianVault threw', { err });
      return { count: 0, errors: [String(err)] };
    }
  });

  // ── obsidian vault auto-detection ────────────────────────────────────────
  // Merges vaults registered in Obsidian's own config (obsidian.json - the
  // authoritative list, covers vaults outside ~/Documents) with a shallow
  // ~/Documents scan. Deduped by resolved path.
  ipcBridge.memory.import.obsidianDetectVaults.provider(async () => {
    try {
      const [configured, documents] = await Promise.all([detectConfiguredVaults(), detectVaults()]);
      const byPath = new Map<string, { path: string; mdCount: number }>();
      for (const v of documents) {
        byPath.set(path.resolve(v.path), { path: v.path, mdCount: v.mdFileCount });
      }
      for (const v of configured) {
        // Configured entries win (fresher count, authoritative source).
        byPath.set(path.resolve(v.path), { path: v.path, mdCount: v.mdCount });
      }
      const vaults = [...byPath.values()];
      log.info('[import] obsidianDetectVaults', { count: vaults.length });
      return { vaults };
    } catch (err) {
      log.error('[import] obsidianDetectVaults threw', { err });
      return { vaults: [] };
    }
  });

  // ── dev dir scanner + importer ───────────────────────────────────────────
  ipcBridge.memory.import.scanDevDir.provider(async () => {
    try {
      const memDir = await resolveMemoryDir();
      const candidates = await scanForMemoryDirs();
      // Import all candidates not already in the registry.
      const newCandidatePaths = candidates.filter((c) => !c.alreadyInRegistry).map((c) => c.path);

      if (newCandidatePaths.length === 0) {
        log.info('[import] scanDevDir - no new candidates');
        return { count: 0, projectsFound: candidates.length, errors: [] };
      }

      const { imported, skipped, projectsFound, errors } = await runDevScanImport(newCandidatePaths, {
        ijfwMemoryDir: memDir,
      });
      // Register what the scan found. Without this the scan discovered real
      // IJFW projects and then left them unreachable, because nothing in the
      // app ever wrote registry.md and the index reads its roots from there.
      let registered = 0;
      for (const candidate of newCandidatePaths) {
        if (await registerProject(candidate)) registered++;
      }
      await refreshArchive();
      log.info('[import] scanDevDir done', {
        imported,
        skipped,
        projectsFound,
        registered,
        errorCount: errors.length,
      });
      return { count: imported, projectsFound, errors };
    } catch (err) {
      log.error('[import] scanDevDir threw', { err });
      return { count: 0, projectsFound: 0, errors: [String(err)] };
    }
  });

  // ── drop folder one-shot processor ──────────────────────────────────────
  ipcBridge.memory.import.processDropFolder.provider(async () => {
    // Lazy-start the live watcher if it hasn't been started yet (Fix 7).
    startDropWatcherIfNeeded();
    try {
      const memDir = await resolveMemoryDir();
      const { count, errors } = await runDropFolderProcess({ ijfwMemoryDir: memDir });
      if (count > 0) await refreshArchive();
      log.info('[import] processDropFolder done', { count, errorCount: errors.length });
      return { count, errors };
    } catch (err) {
      log.error('[import] processDropFolder threw', { err });
      return { count: 0, errors: [String(err)] };
    }
  });

  // ── drop folder status getter ─────────────────────────────────────────────
  ipcBridge.memory.import.getDropFolderStatus.provider(async () => getDropFolderStatus());

  // ── drag-drop ingest ─────────────────────────────────────────────────────
  ipcBridge.memory.ingestFiles.provider(async (args) => {
    const parsed = ingestFilesSchema.safeParse(args);
    if (!parsed.success) {
      log.warn('[import] ingestFiles invalid args', { args });
      return { ok: false, ingested: 0, errors: ['invalid args'] };
    }

    // Resolve both scopes up front: `scope` is per-file, and a project-scoped
    // drop must not silently land in the home root (it used to - the scope was
    // parsed and then ignored).
    const dirByScope: Record<'project' | 'global', string> = {
      global: await resolveMemoryDir('global'),
      project: await resolveMemoryDir('project'),
    };
    try {
      await fs.promises.mkdir(dirByScope.global, { recursive: true });
      await fs.promises.mkdir(dirByScope.project, { recursive: true });
    } catch (err) {
      log.error('[import] ingestFiles mkdir failed', { err });
      return { ok: false, ingested: 0, errors: [`Failed to create memory dir: ${String(err)}`] };
    }

    let ingested = 0;
    const errors: string[] = [];

    for (const file of parsed.data.files) {
      // Reject path traversal attempts in the name.
      if (file.name.includes('..') || file.name.includes('/') || file.name.includes('\\')) {
        errors.push(`${file.name}: rejected - invalid name`);
        continue;
      }

      const scope = file.scope ?? 'global';
      const timestamp = Date.now();
      const hash = crypto.createHash('sha1').update(file.content).digest('hex').slice(0, 8);
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.(?:md|txt|json)$/i, '.md');
      const destName = `dropped-${timestamp}-${safeName}`;
      const destPath = path.join(dirByScope[scope], destName);

      const summary = file.content
        .split('\n')[0]
        .slice(0, 200)
        .replace(/[\r\n]+/g, ' ');
      const hasFrontmatter = file.content.trimStart().startsWith('---');

      let fileContent: string;
      if (hasFrontmatter) {
        fileContent = file.content;
      } else {
        const frontmatter = [
          '---',
          `id: ${hash}`,
          `type: observation`,
          `created: ${timestamp}`,
          // The indexer keys an entry's identity off its stored-at instant; an
          // ISO `stored` keeps that identity fixed across restarts.
          `stored: ${new Date(timestamp).toISOString()}`,
          `source: drag-drop`,
          `scope: ${scope}`,
          `summary: ${summary}`,
          '---',
          '',
        ].join('\n');
        fileContent = `${frontmatter}${file.content}\n`;
      }

      try {
        await fs.promises.writeFile(destPath, fileContent, 'utf8');
        ingested++;
        log.info('[import] ingestFiles wrote', { destName });
      } catch (err) {
        log.warn('[import] ingestFiles write failed', { destName, err });
        errors.push(`${file.name}: ${String(err)}`);
      }
    }

    // Rebuild before returning so an ingested file is recallable the moment the
    // call resolves, rather than whenever the directory watcher happens to fire.
    if (ingested > 0) await refreshArchive();

    return { ok: true, ingested, errors };
  });

  // Auto-start the live drop folder watcher at bridge init (no-deferment #10).
  startDropWatcherIfNeeded();
}

/**
 * Start the drop folder watcher exactly once. Subsequent calls are no-ops.
 */
function startDropWatcherIfNeeded(): void {
  if (_dropWatcherHandle !== null) return;
  try {
    _dropWatcherHandle = startDropFolderWatcher({
      ijfwMemoryDir: globalMemoryDir(),
      onIngest: (filename) => {
        log.info('[import] dropFolder auto-ingested', { filename });
      },
      onError: (err) => {
        log.warn('[import] dropFolder watcher error', { err });
      },
    });
    log.info('[import] drop folder watcher started');
  } catch (err) {
    log.warn('[import] failed to start drop folder watcher', { err });
  }
}
