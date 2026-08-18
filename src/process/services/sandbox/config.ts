/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read/write the persisted host-execution sandbox config and build a per-call
 * {@link SandboxPolicy} from it. Mirrors the `getHookGuardConfig` /
 * `setHookGuardEnabled` accessor pair — single source of truth for the Settings
 * bridge and any host spawn seam that opts into confinement.
 *
 * This module never imports the koffi backend (only the type), so reading the
 * config on any platform is free; the native bindings load only when a caller
 * actually runs a confined command through `safeExecFile`.
 *
 * @module @process/services/sandbox/config
 */

import { ProcessConfig } from '@process/utils/initStorage';
import type { ConfinedSandboxMode, SandboxPolicy } from './types';

/** Persisted host-sandbox preference: whether confinement is on, and in which confined mode. */
export type HostSandboxConfig = {
  enabled: boolean;
  mode: ConfinedSandboxMode;
};

/** Safe default when no config is present: OFF, and read-only if ever enabled. */
export const DEFAULT_HOST_SANDBOX: HostSandboxConfig = { enabled: false, mode: 'read-only' };

/**
 * Current host-sandbox config from storage. OFF unless an explicit `true` is
 * stored; mode defaults to `read-only` (the stricter confined mode). Any read
 * failure degrades to OFF — a not-yet-ready store must never appear to enable
 * confinement (fail-safe read; the fail-CLOSED guarantee is enforced separately
 * at run time when a confined policy is actually built).
 *
 * @returns the resolved host-sandbox preference.
 */
export async function getHostSandboxConfig(): Promise<HostSandboxConfig> {
  try {
    const raw = (await ProcessConfig.get('security.hostSandbox')) as { enabled?: boolean; mode?: string } | undefined;
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_HOST_SANDBOX };
    return {
      enabled: raw.enabled === true,
      mode: raw.mode === 'workspace-write' ? 'workspace-write' : 'read-only',
    };
  } catch {
    return { ...DEFAULT_HOST_SANDBOX };
  }
}

/** Persist the host-sandbox preference. */
export async function setHostSandboxConfig(config: HostSandboxConfig): Promise<void> {
  await ProcessConfig.set('security.hostSandbox', config);
}

/**
 * Build the per-call sandbox policy for a host spawn from the stored config.
 * Returns `undefined` when confinement is OFF, so a caller can pass it straight
 * to `safeExecFile({ sandbox })` and get the plain (unconfined) path by default.
 *
 * @param workspaceRoot - the resolved absolute workspace root the command runs in.
 * @returns the confined policy, or `undefined` when the sandbox is disabled.
 */
export async function buildHostSandboxPolicy(workspaceRoot: string): Promise<SandboxPolicy | undefined> {
  const config = await getHostSandboxConfig();
  if (!config.enabled) return undefined;
  return { mode: config.mode, workspaceRoot };
}
