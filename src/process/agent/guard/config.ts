/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read/write the persisted pre-tool guard config. Single source of truth for
 * both agent seams (WCore / ACP) and the Settings bridge, mirroring the
 * `compressionMode` (`getCompressionMode` / `setCompressionMode`) and ECC
 * GateGuard (`isGateGuardEnabled` / `setGateGuardEnabled`) accessor pairs.
 *
 * Default (absent config) is ENABLED with an empty additive ruleset - the
 * built-in destructive floor + secret/risky warn rules live in code
 * (`defaultRules.ts`) and always apply; `config.rules` only adds to them.
 * Reads are tolerant of a not-yet-ready store: any failure degrades to the
 * enabled default so the destructive floor is never silently dropped.
 */

import { ProcessConfig } from '@process/utils/initStorage';
import type { GuardRule } from './types';

export type HookGuardConfig = {
  enabled: boolean;
  /** Additive, user-authored rules layered on top of the built-in ruleset. */
  rules: GuardRule[];
};

/** The safe default applied when no guard config is present. */
export const DEFAULT_HOOK_GUARD_ENABLED = true;

/**
 * Current guard config from storage. Enabled unless an explicit `false` is
 * stored; rules default to empty. Any read failure degrades to the enabled
 * default (fail-safe: the destructive floor keeps running).
 */
export async function getHookGuardConfig(): Promise<HookGuardConfig> {
  try {
    const raw = (await ProcessConfig.get('agent.hookGuard')) as { enabled?: boolean; rules?: GuardRule[] } | undefined;
    if (!raw || typeof raw !== 'object') {
      return { enabled: DEFAULT_HOOK_GUARD_ENABLED, rules: [] };
    }
    return {
      enabled: raw.enabled !== false,
      rules: Array.isArray(raw.rules) ? raw.rules : [],
    };
  } catch {
    return { enabled: DEFAULT_HOOK_GUARD_ENABLED, rules: [] };
  }
}

/**
 * Persist the enabled flag, preserving any existing additive ruleset. A read
 * failure while loading the current rules degrades to an empty ruleset rather
 * than throwing.
 */
export async function setHookGuardEnabled(enabled: boolean): Promise<void> {
  let rules: GuardRule[] = [];
  try {
    const current = (await ProcessConfig.get('agent.hookGuard')) as { rules?: GuardRule[] } | undefined;
    if (current && Array.isArray(current.rules)) {
      rules = current.rules;
    }
  } catch {
    // No readable prior config - persist with an empty ruleset.
  }
  await ProcessConfig.set('agent.hookGuard', { enabled, rules });
}
