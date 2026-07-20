/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HookGuardService - the pure, synchronous, regex-only evaluator at the heart
 * of the native pre-tool guard. It combines the hardcoded destructive floor +
 * the secret/risky defaults + any config-provided rules and returns a single
 * verdict, with deny winning over warn winning over allow.
 *
 * Safety contract:
 *  - `evaluate` performs NO I/O and never awaits. It is deterministic given its
 *    inputs, so the destructive DENY floor is a pure regex decision.
 *  - `safeEvaluate` wraps `evaluate` in a try/catch and FAILS OPEN (returns
 *    `allow` and logs) on any throw, so a guard bug can never brick the agent.
 *  - An invalid regex in ONE rule is caught per-rule (that rule is skipped),
 *    so a malformed config pattern cannot disable the destructive floor.
 */

import type { GuardEvent, GuardRule, GuardVerdict, NormalizedTool } from './types';
import { DEFAULT_RULES } from './defaultRules';

/**
 * Compiled-regex cache. Patterns are static (built-in) or come from a small,
 * user-authored config set, so an unbounded cache is not a concern; the cache
 * only avoids recompiling the same source on every tool call.
 */
const regexCache = new Map<string, RegExp | null>();

/**
 * Compile `source` once (case-insensitive) and test `subject`. A malformed
 * pattern is cached as `null` and treated as a non-match - never a throw - so
 * a single bad rule degrades to "does not fire" rather than taking down the
 * whole evaluation (and with it the destructive floor).
 */
function testPattern(source: string, subject: string): boolean {
  let compiled = regexCache.get(source);
  if (compiled === undefined) {
    try {
      compiled = new RegExp(source, 'i');
    } catch {
      compiled = null;
    }
    regexCache.set(source, compiled);
  }
  if (compiled === null) return false;
  return compiled.test(subject);
}

/**
 * A rule matches when every provided pattern matches its normalized field
 * (logical AND). A rule with no criteria at all matches nothing - this guards
 * against a malformed config rule becoming an accidental blanket deny/warn.
 */
function ruleMatches(rule: GuardRule, tool: NormalizedTool): boolean {
  let hasCriterion = false;

  if (rule.tool !== undefined) {
    hasCriterion = true;
    if (!tool.toolName || !testPattern(rule.tool, tool.toolName)) return false;
  }
  if (rule.commandPattern !== undefined) {
    hasCriterion = true;
    if (!tool.command || !testPattern(rule.commandPattern, tool.command)) return false;
  }
  if (rule.pathPattern !== undefined) {
    hasCriterion = true;
    if (!tool.filePath || !testPattern(rule.pathPattern, tool.filePath)) return false;
  }
  if (rule.contentPattern !== undefined) {
    hasCriterion = true;
    if (!tool.content || !testPattern(rule.contentPattern, tool.content)) return false;
  }

  return hasCriterion;
}

/**
 * Evaluate a normalized tool against the built-in rules plus `configRules`.
 * Pure and synchronous. Deny wins over warn wins over allow: the first matching
 * deny short-circuits; otherwise the first matching warn is returned; otherwise
 * allow.
 *
 * The built-in `DEFAULT_RULES` (destructive floor + risky + secret) are always
 * evaluated first, so an empty `configRules` still enforces the floor.
 */
export function evaluate(
  tool: NormalizedTool,
  event: GuardEvent,
  configRules: readonly GuardRule[] = []
): GuardVerdict {
  const rules: readonly GuardRule[] = [...DEFAULT_RULES, ...configRules];

  let firstWarn: GuardVerdict | null = null;

  for (const rule of rules) {
    if (rule.event !== event) continue;
    if (!ruleMatches(rule, tool)) continue;

    if (rule.action === 'deny') {
      return { action: 'deny', ruleId: rule.id, message: rule.message };
    }
    if (rule.action === 'warn' && firstWarn === null) {
      firstWarn = { action: 'warn', ruleId: rule.id, message: rule.message };
    }
  }

  return firstWarn ?? { action: 'allow' };
}

/**
 * Fail-open wrapper around {@link evaluate}. Returns `allow` (and logs) on ANY
 * throw - a guard defect must never block or crash the agent. This is the ONLY
 * entry point the WCore / ACP seams call.
 */
export function safeEvaluate(
  tool: NormalizedTool,
  event: GuardEvent,
  configRules: readonly GuardRule[] = []
): GuardVerdict {
  try {
    return evaluate(tool, event, configRules);
  } catch (err) {
    console.warn('[HookGuard] evaluation failed - failing open (allow):', err);
    return { action: 'allow' };
  }
}
