/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * eccSystemService - installs the bundled ECC agent harness into the user's
 * ~/.claude on first run, and exposes the GateGuard toggle state.
 *
 * The bundle (resources/bundled-ecc, staged by scripts/prepareEcc.js) carries
 * ECC's own offline installer. The manual `--target claude` install writes
 * rules/skills namespaced under ~/.claude/rules/ecc and ~/.claude/skills/ecc,
 * plus flat agents/commands - and does NOT touch the user's global
 * ~/.claude/settings.json. The ECC hooks (quality gates, format/typecheck,
 * GateGuard, ...) are instead activated per conversation workspace via
 * ensureWorkspaceEccHooks(), so the full quality machinery runs by default
 * inside Darhai without hijacking the user's standalone claude CLI.
 *
 * Never-clobber policy: if any sign of an existing ECC install is present
 * (manual install marker, namespaced dirs, or the ecc plugin cache), seeding
 * is skipped entirely so a user-managed install is never touched.
 *
 * GateGuard toggle: `ecc.gateGuardEnabled` (default true). An explicit false
 * makes Darhai inject ECC_GATEGUARD=off into claude agent spawns, silencing
 * only the fact-forcing gate while the other quality hooks keep running.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import log from 'electron-log';
import { electronUtilityProcess } from '@/common/electronSafe';
import { ProcessConfig } from '@process/utils/initStorage';

const INSTALL_TIMEOUT_MS = 180_000;

/** Resolve the bundled ECC payload dir, or null outside a packaged build. */
function bundledEccDir(): string | null {
  const base = process.resourcesPath;
  if (!base || typeof base !== 'string') return null;
  return path.join(base, 'bundled-ecc');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

type EccInstallState = 'complete' | 'foreign-artifacts' | 'absent';

/**
 * Classify the user's ~/.claude ECC state. Only the installer's final
 * install-state.json (written last) or a plugin-cache dir prove a COMPLETE
 * install; bare rules/ecc / skills/ecc dirs are partial artifacts - retryable
 * when they came from our own interrupted seed (sentinel set), untouchable
 * otherwise (user-managed install - never clobber).
 */
async function classifyInstall(homeDir: string): Promise<EccInstallState> {
  const claudeDir = path.join(homeDir, '.claude');
  if (
    (await pathExists(path.join(claudeDir, 'ecc', 'install-state.json'))) ||
    (await pathExists(path.join(claudeDir, 'plugins', 'cache', 'ecc')))
  ) {
    return 'complete';
  }
  if (
    (await pathExists(path.join(claudeDir, 'rules', 'ecc'))) ||
    (await pathExists(path.join(claudeDir, 'skills', 'ecc')))
  ) {
    return 'foreign-artifacts';
  }
  return 'absent';
}

/** True when a previous Darhai seed started but never verified completion. */
async function isOwnSeedInProgress(): Promise<boolean> {
  try {
    return ((await ProcessConfig.get('ecc.seedInProgress')) as unknown) === true;
  } catch {
    return false;
  }
}

async function readAutoInstallSetting(): Promise<boolean> {
  try {
    const v = (await ProcessConfig.get('ecc.autoInstall')) as unknown;
    // Default ON; only an explicit false opts out.
    return v !== false && v !== 'false';
  } catch {
    return true;
  }
}

/** GateGuard toggle state - default ON (only an explicit false disables). */
export async function isGateGuardEnabled(): Promise<boolean> {
  try {
    const v = (await ProcessConfig.get('ecc.gateGuardEnabled')) as unknown;
    return v !== false && v !== 'false';
  } catch {
    return true;
  }
}

export async function setGateGuardEnabled(enabled: boolean): Promise<void> {
  await ProcessConfig.set('ecc.gateGuardEnabled', enabled);
}

export type EccStatus = {
  bundled: boolean;
  installed: boolean;
  gateGuardEnabled: boolean;
};

export async function getEccStatus(): Promise<EccStatus> {
  const bundle = bundledEccDir();
  const bundled = bundle !== null && (await pathExists(path.join(bundle, 'scripts', 'install-apply.js')));
  return {
    bundled,
    installed: (await classifyInstall(os.homedir())) === 'complete',
    gateGuardEnabled: await isGateGuardEnabled(),
  };
}

/**
 * Child env for the installer. The bundled installer resolves its target home
 * as HOME || os.homedir(), so pin BOTH home vars to os.homedir() (a stray
 * Git-Bash/corporate HOME would otherwise install to a different .claude than
 * the one our markers and hook activation read). Node debug vars are stripped
 * for hygiene, mirroring acpConnectors.prepareCleanEnv.
 */
function buildInstallerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const home = os.homedir();
  env.HOME = home;
  env.USERPROFILE = home;
  delete env.NODE_OPTIONS;
  delete env.NODE_INSPECT;
  delete env.NODE_DEBUG;
  return env;
}

/**
 * Run the bundled ECC installer to completion. Uses utilityProcess.fork -
 * the packaged binaries have the RunAsNode fuse turned off (SEC-ELEC-05), so
 * ELECTRON_RUN_AS_NODE would boot a second GUI instance instead of Node;
 * utilityProcess is the only sanctioned Node runtime in a packaged build.
 */
function runBundledInstaller(bundleDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!electronUtilityProcess) {
      reject(new Error('utilityProcess unavailable (non-electron context)'));
      return;
    }
    const installer = path.join(bundleDir, 'scripts', 'install-apply.js');
    const child = electronUtilityProcess.fork(installer, ['--profile', 'full', '--target', 'claude'], {
      env: buildInstallerEnv(),
      stdio: 'pipe',
    });
    // Drain stdout: the installer prints ~150 KB of plan lines; an undrained
    // pipe fills the OS buffer and the child can never flush and exit.
    child.stdout?.resume();
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`ecc install timed out after ${INSTALL_TIMEOUT_MS}ms`));
    }, INSTALL_TIMEOUT_MS);
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ecc installer exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/**
 * Materialize the ECC hooks into a Darhai conversation workspace so the
 * quality machinery (quality gates, format/typecheck on stop, GateGuard, ...)
 * is ACTIVE by default for every claude agent Darhai spawns.
 *
 * Written to <workspace>/.claude/settings.local.json - the machine-local,
 * auto-gitignored settings file Claude Code merges natively. This keeps the
 * hooks out of the shared/committable settings.json, so nothing can leak into
 * a user's repository or their teammates' CLI sessions. The user's global
 * ~/.claude/settings.json is never touched, and the call site skips
 * user-chosen (customWorkspace) directories entirely.
 *
 * Non-destructive: an existing settings.local.json with its own hooks is left
 * alone; a parse failure skips silently; the write is atomic (tmp + rename).
 */
export async function ensureWorkspaceEccHooks(workspaceDir: string): Promise<void> {
  try {
    const hooksSource = path.join(os.homedir(), '.claude', 'hooks', 'hooks.json');
    let raw: string;
    try {
      raw = await fs.promises.readFile(hooksSource, 'utf8');
    } catch {
      return; // no manual install (e.g. plugin-only user - hooks already global)
    }
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    if (!parsed.hooks || typeof parsed.hooks !== 'object') return;

    const settingsDir = path.join(workspaceDir, '.claude');
    const settingsPath = path.join(settingsDir, 'settings.local.json');

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')) as Record<string, unknown>;
      if (existing.hooks !== undefined) return; // already materialized or user-managed
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return; // unparseable - do not clobber
    }

    existing.hooks = parsed.hooks;
    await fs.promises.mkdir(settingsDir, { recursive: true });
    const tmpPath = `${settingsPath}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    await fs.promises.rename(tmpPath, settingsPath);
    log.info('[ecc] workspace hooks materialized', { workspaceDir });
  } catch (err) {
    log.warn('[ecc] ensureWorkspaceEccHooks failed (non-fatal)', { err });
  }
}

let _seedPromise: Promise<boolean> | null = null;

/**
 * Install the bundled ECC harness into ~/.claude if absent. Idempotent and
 * safe to call on every launch; returns true only when a fresh install ran.
 */
export function seedEccIfAbsent(): Promise<boolean> {
  if (_seedPromise) return _seedPromise;
  _seedPromise = (async () => {
    try {
      if (!(await readAutoInstallSetting())) {
        log.info('[ecc] auto-install opted out (ecc.autoInstall=false)');
        return false;
      }
      const bundle = bundledEccDir();
      if (!bundle || !(await pathExists(path.join(bundle, 'scripts', 'install-apply.js')))) {
        return false; // dev run or bundle stripped - nothing to seed
      }
      const home = os.homedir();
      const state = await classifyInstall(home);
      if (state === 'complete') {
        return false;
      }
      if (state === 'foreign-artifacts' && !(await isOwnSeedInProgress())) {
        log.info('[ecc] unmanaged ECC artifacts found in ~/.claude - leaving them untouched');
        return false;
      }
      // Fresh machine, or our own interrupted seed - (re)run the idempotent
      // installer. The sentinel makes a killed attempt retryable next launch.
      await ProcessConfig.set('ecc.seedInProgress', true);
      log.info('[ecc] installing bundled harness into ~/.claude');
      await runBundledInstaller(bundle);
      // Exit code alone is not proof of success - require the completion
      // marker the installer writes as its very last operation.
      if (!(await pathExists(path.join(home, '.claude', 'ecc', 'install-state.json')))) {
        throw new Error('installer exited 0 but install-state.json is missing');
      }
      await ProcessConfig.set('ecc.seedInProgress', false);
      log.info('[ecc] bundled harness installed');
      return true;
    } catch (err) {
      log.warn('[ecc] bundled install failed (will retry next launch)', { err });
      _seedPromise = null; // allow retry on next call/launch
      return false;
    }
  })();
  return _seedPromise;
}
