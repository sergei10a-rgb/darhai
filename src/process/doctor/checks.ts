/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Darhai's diagnostic checks — the pure, dependency-injected half of the
 * Doctor (registry.ts binds these to the live singletons).
 *
 * Every check takes its collaborators as an explicit deps object so it can be
 * unit-tested without Electron, a database, a spawned runtime, or the network.
 * The `t` dependency is the main-process i18n translator: `detail` and
 * `remediation` are resolved to the USER'S language here, while `titleKey`
 * stays a key for the renderer to translate (mirrors the upstream split).
 *
 * None of these checks mutate anything. Subsystems owned by other work
 * streams (voice, llama.cpp, memory) are only READ through their public APIs.
 */

import type { DoctorCheckOutcome } from './types';

/** Main-process translator signature (i18next's `t`, narrowed). */
export type DoctorTranslate = (key: string, options?: Record<string, unknown>) => string;

/** Disk space below this many GiB is a hard fail — the app will misbehave. */
export const DISK_FAIL_BELOW_GB = 1;
/** Disk space below this many GiB is a warning — downloads will start failing. */
export const DISK_WARN_BELOW_GB = 5;

const GIB = 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 1. Bundled bun runtime (drives builtin MCP servers and the IJFW runtime).
// ---------------------------------------------------------------------------

export type BunRuntimeDeps = {
  /** `resolveBuiltinMcpRuntime()` — `{ command }`, 'node' when bun is absent. */
  resolveRuntime: () => { command: string };
  fileExists: (path: string) => boolean;
  t: DoctorTranslate;
};

export function checkBunRuntime(deps: BunRuntimeDeps): DoctorCheckOutcome {
  const { command } = deps.resolveRuntime();
  if (command === 'node') {
    return {
      status: 'warn',
      detail: deps.t('settings.doctor.checks.bun.fallback'),
      remediation: deps.t('settings.doctor.checks.bun.fallbackFix'),
    };
  }
  if (!deps.fileExists(command)) {
    return {
      status: 'fail',
      detail: deps.t('settings.doctor.checks.bun.missing', { path: command }),
      remediation: deps.t('settings.doctor.checks.bun.missingFix'),
    };
  }
  return { status: 'pass', detail: deps.t('settings.doctor.checks.bun.ok', { path: command }) };
}

// ---------------------------------------------------------------------------
// 2. Builtin MCP servers (config-level: registered + enabled).
// ---------------------------------------------------------------------------

export type BuiltinMcpServerEntry = { builtin?: boolean; enabled?: boolean; name?: string };

export type BuiltinMcpDeps = {
  /** The persisted `mcp.config` list, read in-process (never over the bridge). */
  listServers: () => Promise<BuiltinMcpServerEntry[]>;
  t: DoctorTranslate;
};

export async function checkBuiltinMcp(deps: BuiltinMcpDeps): Promise<DoctorCheckOutcome> {
  const servers = await deps.listServers();
  const builtin = servers.filter((server) => server.builtin === true);
  if (builtin.length === 0) {
    return {
      status: 'warn',
      detail: deps.t('settings.doctor.checks.mcp.none'),
      remediation: deps.t('settings.doctor.checks.mcp.noneFix'),
    };
  }
  const enabled = builtin.filter((server) => server.enabled === true);
  if (enabled.length === 0) {
    return {
      status: 'warn',
      detail: deps.t('settings.doctor.checks.mcp.disabled', { total: builtin.length }),
      remediation: deps.t('settings.doctor.checks.mcp.disabledFix'),
    };
  }
  return {
    status: 'pass',
    detail: deps.t('settings.doctor.checks.mcp.ok', { enabled: enabled.length, total: builtin.length }),
  };
}

// ---------------------------------------------------------------------------
// 3. llama.cpp runtime install receipt.
// ---------------------------------------------------------------------------

export type LlamaRuntimeDeps = {
  /** Installed version tags, newest first (`listInstalledTags`). */
  listTags: () => string[];
  /** Receipt + files + linked-libs verification for one tag (`isInstalled`). */
  isTagInstalled: (tag: string) => boolean;
  t: DoctorTranslate;
};

export function checkLlamaRuntime(deps: LlamaRuntimeDeps): DoctorCheckOutcome {
  const tags = deps.listTags();
  if (tags.length === 0) {
    // llama.cpp is an optional local runtime — absence is informational.
    return {
      status: 'warn',
      detail: deps.t('settings.doctor.checks.llama.none'),
      remediation: deps.t('settings.doctor.checks.llama.noneFix'),
    };
  }
  const newest = tags[0];
  if (!deps.isTagInstalled(newest)) {
    return {
      status: 'fail',
      detail: deps.t('settings.doctor.checks.llama.broken', { tag: newest }),
      remediation: deps.t('settings.doctor.checks.llama.brokenFix'),
    };
  }
  return { status: 'pass', detail: deps.t('settings.doctor.checks.llama.ok', { tag: newest }) };
}

// ---------------------------------------------------------------------------
// 4. Mongolian voice components (STT runtime, STT model, TTS bundle).
// ---------------------------------------------------------------------------

export type MongolVoiceComponentState = { installed: boolean; supported: boolean };

export type MongolVoiceDoctorDeps = {
  /** `MongolVoiceProvisioner.status()` — per-component install state. */
  status: () => Record<string, MongolVoiceComponentState>;
  t: DoctorTranslate;
};

export function checkMongolVoice(deps: MongolVoiceDoctorDeps): DoctorCheckOutcome {
  const status = deps.status();
  const components = Object.entries(status);
  const supported = components.filter(([, state]) => state.supported);
  if (supported.length === 0) {
    return { status: 'warn', detail: deps.t('settings.doctor.checks.voice.unsupported') };
  }
  const installed = supported.filter(([, state]) => state.installed);
  if (installed.length === supported.length) {
    return {
      status: 'pass',
      detail: deps.t('settings.doctor.checks.voice.ok', { installed: installed.length, total: supported.length }),
    };
  }
  const missing = supported
    .filter(([, state]) => !state.installed)
    .map(([name]) => name)
    .join(', ');
  return {
    status: 'warn',
    detail: deps.t('settings.doctor.checks.voice.partial', {
      installed: installed.length,
      total: supported.length,
      missing,
    }),
    remediation: deps.t('settings.doctor.checks.voice.partialFix'),
  };
}

// ---------------------------------------------------------------------------
// 5. ffmpeg on PATH (video frames + Mongolian STT preprocessing).
// ---------------------------------------------------------------------------

export type FfmpegDeps = {
  /** `resolveFfmpegBinary()` — absolute path, or null when not on PATH. */
  resolveBinary: () => string | null;
  t: DoctorTranslate;
};

export function checkFfmpeg(deps: FfmpegDeps): DoctorCheckOutcome {
  const binary = deps.resolveBinary();
  if (binary === null) {
    return {
      status: 'warn',
      detail: deps.t('settings.doctor.checks.ffmpeg.missing'),
      remediation: deps.t('settings.doctor.checks.ffmpeg.missingFix'),
    };
  }
  return { status: 'pass', detail: deps.t('settings.doctor.checks.ffmpeg.ok', { path: binary }) };
}

// ---------------------------------------------------------------------------
// 6. OmniRoute gateway process + health probe.
// ---------------------------------------------------------------------------

export type OmnirouteDeps = {
  /** `omnirouteRuntime.getStatus().state` — this session's child, if any. */
  getState: () => string;
  /** `testOmnirouteGatewayConnection` against localhost — never throws. */
  probe: () => Promise<{ ok: boolean; modelCount?: number; error?: string }>;
  t: DoctorTranslate;
};

export async function checkOmniroute(deps: OmnirouteDeps): Promise<DoctorCheckOutcome> {
  const state = deps.getState();
  const probe = await deps.probe();
  if (probe.ok === true) {
    return {
      status: 'pass',
      detail: deps.t('settings.doctor.checks.omniroute.ok', { models: probe.modelCount ?? 0 }),
    };
  }
  if (state === 'running') {
    // We believe we own a running child, yet the port does not answer.
    return {
      status: 'fail',
      detail: deps.t('settings.doctor.checks.omniroute.unreachable', { error: probe.error ?? 'unknown' }),
      remediation: deps.t('settings.doctor.checks.omniroute.unreachableFix'),
    };
  }
  // Not running and nothing external on the port: optional subsystem, warn.
  return {
    status: 'warn',
    detail: deps.t('settings.doctor.checks.omniroute.stopped'),
    remediation: deps.t('settings.doctor.checks.omniroute.stoppedFix'),
  };
}

// ---------------------------------------------------------------------------
// 7. Memory index health.
// ---------------------------------------------------------------------------

export type MemoryIndexDeps = {
  /** `getIjfwArchiveService().indexStats()` — sync snapshot; throws on a broken index. */
  indexStats: () => { total: number; projects: number };
  t: DoctorTranslate;
};

export function checkMemoryIndex(deps: MemoryIndexDeps): DoctorCheckOutcome {
  const stats = deps.indexStats();
  // A not-yet-initialized singleton answers { total: 0 } exactly like a
  // healthy-but-empty index; the check cannot tell them apart, so a "pass"
  // here would be unverifiable (M2). Warn and say which two states it may be.
  if (stats.total === 0) {
    return {
      status: 'warn',
      detail: deps.t('settings.doctor.checks.memory.empty'),
      remediation: deps.t('settings.doctor.checks.memory.emptyFix'),
    };
  }
  return {
    status: 'pass',
    detail: deps.t('settings.doctor.checks.memory.ok', { total: stats.total, projects: stats.projects }),
  };
}

// ---------------------------------------------------------------------------
// 8. Free disk space under the app's data directory.
// ---------------------------------------------------------------------------

export type DiskSpaceDeps = {
  /** Free bytes on the volume holding the app's data dir. Throws when unknown. */
  freeBytes: () => Promise<number>;
  t: DoctorTranslate;
};

export async function checkDiskSpace(deps: DiskSpaceDeps): Promise<DoctorCheckOutcome> {
  let free: number;
  try {
    free = await deps.freeBytes();
  } catch {
    return { status: 'warn', detail: deps.t('settings.doctor.checks.disk.unknown') };
  }
  const freeGb = free / GIB;
  const rounded = Math.round(freeGb * 10) / 10;
  if (freeGb < DISK_FAIL_BELOW_GB) {
    return {
      status: 'fail',
      detail: deps.t('settings.doctor.checks.disk.critical', { freeGb: rounded }),
      remediation: deps.t('settings.doctor.checks.disk.criticalFix'),
    };
  }
  if (freeGb < DISK_WARN_BELOW_GB) {
    return {
      status: 'warn',
      detail: deps.t('settings.doctor.checks.disk.low', { freeGb: rounded }),
      remediation: deps.t('settings.doctor.checks.disk.lowFix'),
    };
  }
  return { status: 'pass', detail: deps.t('settings.doctor.checks.disk.ok', { freeGb: rounded }) };
}
