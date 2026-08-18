/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Native pre-tool guard - barrel export. The guard evaluates a normalized
 * (toolName, input) tuple at Darhai's own approval seams (WCore / ACP) and
 * returns allow / deny / warn, in front of any auto-approve or "always allow"
 * cache. See {@link ./HookGuardService} for the fail-open contract.
 */

export type { GuardAction, GuardEvent, GuardRule, GuardVerdict, NormalizedTool } from './types';
export { evaluate, safeEvaluate } from './HookGuardService';
export { normalizeAcp, normalizeWcore } from './normalize';
export type { AcpToolCallLike, WCoreToolLike } from './normalize';
export { DEFAULT_RULES, DESTRUCTIVE_FLOOR_RULES, RISKY_RULES, SECRET_WRITE_RULES } from './defaultRules';
export { DEFAULT_HOOK_GUARD_ENABLED, getHookGuardConfig, setHookGuardEnabled, type HookGuardConfig } from './config';
export {
  RepeatToolReminder,
  DEFAULT_REPEAT_THRESHOLDS,
  DEFAULT_REPEAT_EXCLUDE,
  DEFAULT_ARGUMENTS_PREVIEW_CHARS,
  type RepeatReminderConfig,
  type RepeatReminderNotice,
} from './RepeatToolReminder';
