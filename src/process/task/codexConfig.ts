/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { isCodexNoSandboxMode } from '@/common/types/codex/codexModes';
import { copyFile, mkdir, readFile, rm, stat, symlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join, posix, win32 } from 'path';
import { getDataPath } from '@process/utils/utils';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type SupportedCodexSandboxMode = 'workspace-write' | 'danger-full-access';

const isWindowsStylePath = (value: string): boolean => /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');

const getCodexPathApi = (baseDirectory: string) =>
  process.platform === 'win32' || isWindowsStylePath(baseDirectory) ? win32 : posix;

export function normalizeCodexSandboxMode(sandboxMode?: CodexSandboxMode | null): SupportedCodexSandboxMode {
  return sandboxMode === 'danger-full-access' ? 'danger-full-access' : 'workspace-write';
}

export function getCodexSandboxModeForSessionMode(
  mode?: string | null,
  fallbackMode?: CodexSandboxMode | null
): SupportedCodexSandboxMode {
  if (mode) {
    return isCodexNoSandboxMode(mode) ? 'danger-full-access' : 'workspace-write';
  }

  return normalizeCodexSandboxMode(fallbackMode);
}

export function getCodexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome) {
    return getCodexPathApi(codexHome).join(codexHome, 'config.toml');
  }

  const homeDirectory = homedir();
  return getCodexPathApi(homeDirectory).join(homeDirectory, '.codex', 'config.toml');
}

/**
 * Return `content` with `sandbox_mode` set to `sandboxMode`, leaving every other
 * line of the user's TOML exactly as it was.
 */
export function applyCodexSandboxMode(content: string, sandboxMode: CodexSandboxMode): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const sandboxLine = `sandbox_mode = "${sandboxMode}"`;
  let nextContent: string;

  if (/^\s*sandbox_mode\s*=.*$/m.test(content)) {
    nextContent = content.replace(/^\s*sandbox_mode\s*=.*$/m, sandboxLine);
  } else {
    const sectionIndex = content.search(/^\s*\[/m);

    if (sectionIndex >= 0) {
      const prefix = content.slice(0, sectionIndex).trimEnd();
      const suffix = content.slice(sectionIndex);
      nextContent = prefix
        ? `${prefix}${newline}${sandboxLine}${newline}${newline}${suffix}`
        : `${sandboxLine}${newline}${newline}${suffix}`;
    } else if (content.trim().length > 0) {
      nextContent = `${content.trimEnd()}${newline}${sandboxLine}${newline}`;
    } else {
      nextContent = `${sandboxLine}${newline}`;
    }
  }

  return nextContent;
}

/** The Codex home the USER owns - the one their own `codex` CLI reads. */
export function getUserCodexHome(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome) return codexHome;
  const homeDirectory = homedir();
  return getCodexPathApi(homeDirectory).join(homeDirectory, '.codex');
}

/** The Codex home Darhai owns, and the only one it writes to. */
export function getManagedCodexHome(): string {
  return join(getDataPath(), 'codex-home');
}

/**
 * Build a Codex home of our own and return its path, for `CODEX_HOME`.
 *
 * Darhai used to write `sandbox_mode` straight into the user's own
 * `~/.codex/config.toml`. Only that one line changed, but the file is not ours:
 * it is what the user's `codex` command reads in their terminal, so launching
 * an agent here silently changed how their CLI behaves everywhere else - and
 * with `danger-full-access` that means their own codex stops sandboxing. There
 * was no prompt, and nothing said it had happened.
 *
 * So we copy their config, override only `sandbox_mode` in the copy, and point
 * the spawned CLI at that. Their file is never opened for writing.
 *
 * `auth.json` is the exception, deliberately: it is linked rather than copied so
 * a token the CLI refreshes lands back in the user's real home and they stay
 * signed in on both sides. Windows refuses symlinks without developer mode, so
 * that falls back to a copy - which still authenticates, and still leaves their
 * file alone.
 */
export async function materializeCodexHome(sandboxMode: CodexSandboxMode): Promise<string> {
  const managedHome = getManagedCodexHome();
  const userHome = getUserCodexHome();
  await mkdir(managedHome, { recursive: true });

  let userConfig = '';
  try {
    userConfig = await readFile(join(userHome, 'config.toml'), 'utf8');
  } catch {
    // No config of their own; ours starts from nothing.
  }
  await writeFile(join(managedHome, 'config.toml'), applyCodexSandboxMode(userConfig, sandboxMode), 'utf8');

  await linkCodexAuth(userHome, managedHome);
  return managedHome;
}

/** Point the managed home's `auth.json` at the user's, so one sign-in serves both. */
async function linkCodexAuth(userHome: string, managedHome: string): Promise<void> {
  const source = join(userHome, 'auth.json');
  const target = join(managedHome, 'auth.json');

  try {
    await stat(source);
  } catch {
    // Not signed in yet. Leave the managed home without an auth.json rather
    // than creating a dangling link the CLI would trip over; the next spawn
    // picks it up once they sign in.
    await rm(target, { force: true }).catch(() => {});
    return;
  }

  // An existing link may point at a stale path (the user moved home, or a
  // previous run fell back to a copy). Replace it rather than trusting it.
  await rm(target, { force: true }).catch(() => {});

  try {
    await symlink(source, target, 'file');
    return;
  } catch {
    // Windows without developer mode, or a filesystem that has no symlinks.
    // A copy still signs the agent in. The cost is that a token refreshed by
    // the spawned CLI stays in our copy, so the user may have to sign in again
    // in their terminal eventually - better than not launching at all.
  }

  try {
    await copyFile(source, target);
  } catch (error) {
    console.warn('[codexConfig] Could not provide auth.json to the managed Codex home:', error);
  }
}
