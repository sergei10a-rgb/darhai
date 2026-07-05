/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wayland Core profile PATH layer (WS-2 P3, Design B - directory isolation).
 *
 * This is the pure, dependency-light resolution layer shared by:
 *  - `profileStore.ts`   (profile mutations + human-only IPC),
 *  - `configBridge.ts`   (reads/writes the ACTIVE profile's `config.toml`),
 *  - `envBuilder.ts`     (sets `DARHAI_HOME` on the engine spawn).
 *
 * It deliberately imports NOTHING from `@/common` (no `ipcBridge`) so that the
 * security-load-bearing config/spawn paths never pull the IPC graph in and no
 * import cycle can form.
 *
 * ── The isolation model ────────────────────────────────────────────────────
 * Each profile is a self-contained config tree under `~/.darhai/profiles/<name>/`.
 * The engine reads its ENTIRE state (config.toml, memory.db, skills) relative to
 * `wayland_config_dir()`, which honours `$DARHAI_HOME` first
 * (`crates/wcore-config/src/config.rs` - `DARHAI_HOME` is the literal config
 * dir, NOT `<DARHAI_HOME>/wayland-core`). So pointing `DARHAI_HOME` at a
 * profile dir gives that profile its own model, tools, security, and memory -
 * exactly the "directory-isolated, no cross-contamination" contract.
 *
 * The `default` profile maps to the NATIVE config dir
 * (`dirs::config_dir()/wayland-core`), NOT a `profiles/default/` folder, so
 * existing installs keep their config and `default` stays byte-for-byte the
 * engine's own out-of-the-box location. Only NAMED profiles relocate.
 *
 * SECURITY (SEC-4): every renderer-supplied `name` is sanitised by
 * {@link assertSafeProfileName} and contained under the profiles root by
 * {@link resolveProfileDir} (realpath-of-parent check) before any fs op.
 */

import { mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** Strict profile-name allowlist: ASCII letters, digits, `_`, `-`; 1-64 chars. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Windows-reserved device base names (case-insensitive), never valid as dirs. */
const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** The default profile name, always present and never deletable. */
export const DEFAULT_PROFILE = 'default';

/** Filename of the active-profile marker stored at the profiles root. */
const ACTIVE_MARKER = '.active';

/**
 * Throw if `name` is not a safe single-segment profile name. Returns the name
 * unchanged when valid. PURE validator - no fs access - so it can be unit-tested
 * directly and reused by every mutating op.
 */
export function assertSafeProfileName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new Error('profile name must be a string');
  }
  if (name === '.' || name === '..') {
    throw new Error('profile name must not be a relative path segment');
  }
  if (name.includes('/') || name.includes('\\') || name.includes(sep)) {
    throw new Error('profile name must not contain a path separator');
  }
  if (WINDOWS_RESERVED.has(name.toUpperCase())) {
    throw new Error('profile name must not be a reserved device name');
  }
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error('profile name must match ^[A-Za-z0-9_-]{1,64}$');
  }
  return name;
}

/** Absolute path to the profiles root (`~/.darhai/profiles`). */
export function profilesRoot(): string {
  return join(homedir(), '.darhai', 'profiles');
}

/**
 * Resolve a profile directory path from a name, asserting (via realpath of the
 * parent) that it sits DIRECTLY under the profiles root. Defeats symlink and
 * `..` escapes even though the name regex already forbids separators.
 *
 * @returns the absolute, contained profile directory path.
 */
export async function resolveProfileDir(name: string): Promise<string> {
  assertSafeProfileName(name);
  const root = profilesRoot();
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const candidate = resolve(realRoot, name);
  // Parent of the candidate must BE the real root, and the candidate must be a
  // direct child (basename equals the validated name). A symlinked root or a
  // crafted name cannot satisfy both.
  if (dirname(candidate) !== realRoot || basename(candidate) !== name) {
    throw new Error('profile path escapes the profiles root');
  }
  return candidate;
}

/** Path to the active-profile marker file. */
export function activeMarkerPath(): string {
  return join(profilesRoot(), ACTIVE_MARKER);
}

/** Read the active profile name from the marker, defaulting to `default`. */
export async function getActiveProfile(): Promise<string> {
  try {
    const raw = (await readFile(activeMarkerPath(), 'utf-8')).trim();
    return PROFILE_NAME_RE.test(raw) ? raw : DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

/**
 * Platform-native config base, mirroring the engine's `dirs::config_dir()`:
 *  - macOS:   `~/Library/Application Support`
 *  - Windows: `%APPDATA%` (roaming)
 *  - Linux:   `$XDG_CONFIG_HOME` or `~/.config`
 */
function platformConfigBase(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support');
    case 'win32':
      return process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    default: {
      const xdgConfig = process.env.XDG_CONFIG_HOME;
      return xdgConfig && xdgConfig.length > 0 ? xdgConfig : join(home, '.config');
    }
  }
}

/**
 * The NATIVE engine config dir for the `default` profile, mirroring the engine's
 * `wayland_config_dir()` precedence EXACTLY (config.rs):
 *   1. `$DARHAI_HOME`              -> `<DARHAI_HOME>`               (literal dir)
 *   2. `$XDG_DATA_HOME`            -> `<XDG_DATA_HOME>/wayland-core`
 *   3. `dirs::config_dir()`        -> `<config_base>/wayland-core`
 *
 * Reads `process.env` but is otherwise side-effect-free. This is what the engine
 * resolves to when no profile `DARHAI_HOME` is forced, so `default` writes/reads
 * here and stays backward-compatible with existing installs.
 */
export function nativeConfigDir(): string {
  const waylandHome = process.env.DARHAI_HOME;
  if (waylandHome && waylandHome.length > 0) {
    return waylandHome;
  }
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome && xdgDataHome.length > 0) {
    return join(xdgDataHome, 'wayland-core');
  }
  return join(platformConfigBase(), 'wayland-core');
}

/**
 * Resolve the config DIRECTORY for the currently-active profile:
 *  - `default` (or unset)  -> {@link nativeConfigDir} (backward-compatible).
 *  - a named profile       -> `~/.darhai/profiles/<name>/` (isolated tree).
 *
 * This is the single source of truth that BOTH the config bridge (what file the
 * panes edit) and the engine spawn (`DARHAI_HOME`) resolve through, so they can
 * never disagree about which profile is live.
 */
export async function resolveActiveConfigDir(): Promise<string> {
  const active = await getActiveProfile();
  if (active && active !== DEFAULT_PROFILE) {
    return resolveProfileDir(active);
  }
  return nativeConfigDir();
}

/** Resolve the active profile's `config.toml` path. */
export async function resolveActiveConfigPath(): Promise<string> {
  return join(await resolveActiveConfigDir(), 'config.toml');
}
