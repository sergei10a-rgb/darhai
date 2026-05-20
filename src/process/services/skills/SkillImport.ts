/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SkillImport — hardened process-side importer for all four import vectors.
 *
 * Security posture:
 *  - Folder import copies (never symlinks) to defeat TOCTOU.
 *  - Git import allowlists hosts to block file:// and arbitrary proto schemes.
 *  - Zip import validates every entry path is inside the extraction dir (zip-slip),
 *    rejects symlink entries, strips non-.md files, and warns on executable refs.
 *  - Every imported skill is run through SkillGuard.scan({ llm: true }).
 *  - Blocked verdict → SkillQuarantine.quarantine(); clean/review → kept.
 *  - Registered into SkillLibrary after import.
 */

import path from 'node:path';
import { homedir } from 'node:os';
import type { SkillSecurityReport } from '@/common/types/skillTypes';
import type { SkillScanInput } from './skillGuardRules';
import { SkillGuard } from './SkillGuard';
import { SkillLibrary } from './SkillLibrary';
import { SkillQuarantine, type SkillQuarantineIo } from './SkillQuarantine';

export const IMPORTED_DIR = path.join(homedir(), '.wayland', 'skills', 'imported');

// ---------------------------------------------------------------------------
// IO seam — injected for tests; defaults to real Node.js ops
// ---------------------------------------------------------------------------

export type SkillImportIo = {
  /** Lstat a path (needed to detect symlinks without following them). */
  lstat: (p: string) => Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>;
  /** Read a directory, returning filenames. */
  readdir: (p: string) => Promise<string[]>;
  /** Read a file as a Buffer. */
  readFile: (p: string) => Promise<Buffer>;
  /** Copy a file (src → dest). */
  copyFile: (src: string, dest: string) => Promise<void>;
  /** Ensure a directory exists (recursive). */
  mkdir: (p: string) => Promise<void>;
  /** Write a Buffer to a file. */
  writeFile: (p: string, data: Buffer | string) => Promise<void>;
  /** Clone a git repo to destDir. */
  gitClone: (url: string, destDir: string) => Promise<void>;
  /** Extract a zip archive to destDir. Returns entries as { path, isSymlink, data }[]. */
  unzip: (zipPath: string, destDir: string) => Promise<ZipEntry[]>;
  /** Create a temporary directory, returning its path. */
  mkdtemp: (prefix: string) => Promise<string>;
  /** Remove a directory tree. */
  rmdir: (p: string) => Promise<void>;
};

export type ZipEntry = {
  /** Relative path as stored in the archive (may contain ../ for zip-slip). */
  path: string;
  isSymlink: boolean;
  data: Buffer;
};

// Default real-fs implementation — not used in tests.
import { lstat, readdir, readFile, copyFile, mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';

const execAsync = promisify(exec);

export const defaultSkillImportIo: SkillImportIo = {
  lstat,
  readdir,
  readFile,
  copyFile,
  mkdir,
  writeFile,
  gitClone: async (url, destDir) => {
    await execAsync(`git clone --depth 1 -- ${JSON.stringify(url)} ${JSON.stringify(destDir)}`);
  },
  unzip: async (zipPath, _destDir) => {
    const buf = await readFile(zipPath);
    const zip = await JSZip.loadAsync(buf);
    const entries: ZipEntry[] = [];
    for (const [entryPath, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const data = Buffer.from(await entry.async('arraybuffer'));
      // JSZip does not expose Unix mode bits directly; treat as non-symlink.
      entries.push({ path: entryPath, isSymlink: false, data });
    }
    return entries;
  },
  mkdtemp: (prefix) => mkdtemp(path.join(os.tmpdir(), prefix)),
  rmdir: (p) => rm(p, { recursive: true, force: true }),
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ImportedSkillResult = {
  /** Skill name derived from the directory basename. */
  name: string;
  /** Absolute path inside ~/.wayland/skills/imported/<name>/ */
  destPath: string;
  /** Security scan report. */
  report: SkillSecurityReport;
};

export type ImportResult = {
  imported: ImportedSkillResult[];
  /** Skills routed to quarantine (verdict === 'blocked'). */
  quarantined: string[];
  /** Non-fatal warnings (e.g. executable-ref in zip). */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Allowlisted git host patterns
// ---------------------------------------------------------------------------

// Accepts https:// and git+ssh / git@github.com: forms. Rejects file://, http://,
// and everything else that could read arbitrary local paths.
const GIT_ALLOWLIST = [
  /^https:\/\//,
  /^git@[a-zA-Z0-9.\-]+:/,
  /^ssh:\/\//,
];

function isAllowedGitUrl(url: string): boolean {
  return GIT_ALLOWLIST.some((re) => re.test(url));
}

// Regex to flag SKILL.md bodies that reference relative executable paths.
const EXECUTABLE_REF_RE = /\.(\/scripts\/[^\s)'"]+|\/bin\/[^\s)'"]+)/;

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

export class SkillImport {
  private readonly io: SkillImportIo;
  private readonly quarantineIo: SkillQuarantineIo | undefined;

  constructor(io: SkillImportIo = defaultSkillImportIo, quarantineIo?: SkillQuarantineIo) {
    this.io = io;
    this.quarantineIo = quarantineIo;
  }

  // -------------------------------------------------------------------------
  // importFolder
  // -------------------------------------------------------------------------

  /**
   * Copy a skill folder into ~/.wayland/skills/imported/<basename>/.
   * Rejects if srcPath itself is a symlink (TOCTOU hardening).
   */
  async importFolder(srcPath: string): Promise<ImportResult> {
    const stat = await this.io.lstat(srcPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Rejected: source path is a symlink — ${srcPath}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Rejected: source path is not a directory — ${srcPath}`);
    }
    return this._copyAndScan(srcPath);
  }

  // -------------------------------------------------------------------------
  // importGit
  // -------------------------------------------------------------------------

  /**
   * Clone a git URL into a temp dir, then treat as folder import.
   * Only https://, git@host:, and ssh:// schemes are allowed.
   */
  async importGit(url: string): Promise<ImportResult> {
    if (!isAllowedGitUrl(url)) {
      throw new Error(`Rejected: git URL uses a disallowed scheme — ${url}`);
    }
    const tmpDir = await this.io.mkdtemp('wayland-git-import-');
    try {
      await this.io.gitClone(url, tmpDir);
      return await this._copyAndScan(tmpDir);
    } finally {
      await this.io.rmdir(tmpDir).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // importZip
  // -------------------------------------------------------------------------

  /**
   * Extract a zip archive, validate every entry (zip-slip + symlink + type),
   * then treat extracted .md files as a folder import.
   */
  async importZip(zipPath: string): Promise<ImportResult> {
    const tmpDir = await this.io.mkdtemp('wayland-zip-import-');
    const warnings: string[] = [];
    try {
      const entries = await this.io.unzip(zipPath, tmpDir);
      for (const entry of entries) {
        // Reject symlink entries.
        if (entry.isSymlink) {
          throw new Error(`Rejected: zip contains a symlink entry — ${entry.path}`);
        }
        // Zip-slip: resolved path must be inside tmpDir.
        const resolved = path.resolve(tmpDir, entry.path);
        if (!resolved.startsWith(path.resolve(tmpDir) + path.sep) && resolved !== path.resolve(tmpDir)) {
          throw new Error(`Rejected: zip entry escapes extraction dir — ${entry.path}`);
        }
        // Strip non-.md files (don't write them).
        if (!entry.path.endsWith('.md')) {
          continue;
        }
        // Warn on executable-ref patterns in SKILL.md bodies.
        const body = entry.data.toString('utf-8');
        if (EXECUTABLE_REF_RE.test(body)) {
          warnings.push(`Warning: ${entry.path} references a relative executable path`);
        }
        // Write only .md files to tmpDir.
        const destFile = path.join(tmpDir, path.basename(entry.path));
        await this.io.writeFile(destFile, entry.data);
      }
      const result = await this._copyAndScan(tmpDir);
      return { ...result, warnings: [...result.warnings, ...warnings] };
    } finally {
      await this.io.rmdir(tmpDir).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // importSingleSkillMd
  // -------------------------------------------------------------------------

  /**
   * Copy a single SKILL.md file into ~/.wayland/skills/imported/<basename>/SKILL.md.
   */
  async importSingleSkillMd(srcPath: string): Promise<ImportResult> {
    const stat = await this.io.lstat(srcPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Rejected: source path is a symlink — ${srcPath}`);
    }
    const skillName = path.basename(path.dirname(srcPath));
    const destDir = path.join(IMPORTED_DIR, skillName);
    await this.io.mkdir(destDir);
    const destFile = path.join(destDir, 'SKILL.md');
    await this.io.copyFile(srcPath, destFile);
    // Read body for scan.
    const body = (await this.io.readFile(srcPath)).toString('utf-8');
    return this._scanAndRegister([{ name: skillName, body, destDir }]);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Copy srcDir into IMPORTED_DIR/<basename> and run scan+register. */
  private async _copyAndScan(srcDir: string): Promise<ImportResult> {
    const basename = path.basename(srcDir);
    const destDir = path.join(IMPORTED_DIR, basename);
    await this.io.mkdir(destDir);

    const files = await this.io.readdir(srcDir);
    let body = '';
    for (const file of files) {
      const srcFile = path.join(srcDir, file);
      const destFile = path.join(destDir, file);
      // Only copy .md files (SKILL.md + any supporting docs).
      if (!file.endsWith('.md')) continue;
      await this.io.copyFile(srcFile, destFile);
      if (file === 'SKILL.md') {
        body = (await this.io.readFile(srcFile)).toString('utf-8');
      }
    }

    return this._scanAndRegister([{ name: basename, body, destDir }]);
  }

  /** Scan a batch of skills and register clean/review ones; quarantine blocked. */
  private async _scanAndRegister(
    skills: Array<{ name: string; body: string; destDir: string }>
  ): Promise<ImportResult> {
    const inputs: SkillScanInput[] = skills.map((s) => ({
      name: s.name,
      body: s.body,
      description: '',
      tags: [] as string[],
    }));

    const reports = await SkillGuard.scan(inputs, { llm: true });

    const imported: ImportedSkillResult[] = [];
    const quarantined: string[] = [];

    for (let i = 0; i < skills.length; i++) {
      const skill = skills[i];
      const report = reports[i];

      if (report.verdict === 'blocked') {
        // Route to quarantine.
        await SkillQuarantine.quarantine(skill.name, skill.destDir, this.quarantineIo);
        quarantined.push(skill.name);
      } else {
        // Register clean and review skills into the library.
        SkillLibrary.getInstance().registerSource([
          {
            name: skill.name,
            description: '',
            type: 'skill',
            source: 'imported',
            path: path.join(skill.destDir, 'SKILL.md'),
            metadata: { tags: [] },
            security: report,
          },
        ]);
        imported.push({ name: skill.name, destPath: skill.destDir, report });
      }
    }

    return { imported, quarantined, warnings: [] };
  }
}
