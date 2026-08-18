/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Advisory per-agent repeat-tool-call reminder - a loop breaker ported from
 * deepseek-harness `@deepseek-ai/dsh-repeat-tool-reminder`. It watches each
 * agent's stream of tool calls, counts runs of consecutive calls to the same
 * tool with identical canonicalized arguments, and at configured run lengths
 * returns an escalating advisory reminder telling the model to stop repeating
 * itself, re-read the last result, and change approach or conclude.
 *
 * Why Darhai needs it: local weak models on the llama.cpp / WCore backends fall
 * into exactly this trap - hammering the same tool call with identical
 * arguments - and burn tokens with no progress. The stateless
 * {@link ./HookGuardService} floor cannot catch it (it has no memory across
 * calls); this tracker keeps a per-agent chain and nudges the model out.
 *
 * ADVISORY ONLY. Unlike the destructive floor, this NEVER denies or rewrites a
 * call - a legitimately repeated call is delayed by nothing and blocked by
 * nothing. The decision (retry differently, gather more evidence, or finish)
 * stays entirely with the model. The reminder text is model-facing (injected as
 * a synthetic notice), not user-facing UI, so it stays English for parity with
 * the upstream template and reliability on weak local models.
 *
 * Design notes vs. the stateless guard:
 *  - This is STATEFUL: it keeps a `WeakMap<object, Chain>` keyed by the live
 *    agent object, so one agent's repetition never trips another's reminder and
 *    object lifetime bounds the entry (no disposal listener needed).
 *  - Misconfiguration FAILS LOUD at construction (an empty `thresholds` list, a
 *    non-integer, a value below 2, or a duplicate throws) - never a silent
 *    fall-back to defaults. `observe` itself never throws.
 *  - Wildcard `include`/`exclude` patterns are compiled case-insensitively, to
 *    match the rest of Darhai's guard layer (HookGuardService compiles every
 *    rule with the `i` flag).
 */

/** Consecutive-repeat counts that trigger a reminder when none are configured. */
export const DEFAULT_REPEAT_THRESHOLDS: readonly number[] = [3, 5, 8];

/** Cap on canonical-argument characters quoted in the detailed reminder. */
export const DEFAULT_ARGUMENTS_PREVIEW_CHARS = 500;

/**
 * Bookkeeping tools that are transparent to the chain by default: interleaving
 * one of them into a loop must not launder it. `grep X -> todo_write -> grep X`
 * still counts as two consecutive `grep X`. Compiled case-insensitively, so
 * `todo_write`, `TodoWrite`, and `TODO_WRITE` are all covered.
 */
export const DEFAULT_REPEAT_EXCLUDE: readonly string[] = ['todo_write', 'todowrite'];

/** Configuration for {@link RepeatToolReminder}. All fields optional; defaults applied at construction. */
export type RepeatReminderConfig = {
  /** Consecutive-repeat counts that trigger a reminder (default `[3, 5, 8]`). */
  thresholds?: number[];
  /** Tool-name wildcard patterns to track; empty means every tool is tracked. */
  include?: string[];
  /** Tool-name wildcard patterns transparent to the chain (neither count nor reset). */
  exclude?: string[];
  /** Max characters of canonical arguments quoted in the detailed reminder (default 500). */
  argumentsPreviewChars?: number;
};

/** An advisory reminder produced when a run length hits a configured threshold. */
export type RepeatReminderNotice = {
  /** The repeated tool's name. */
  toolName: string;
  /** The consecutive-call count that hit the threshold. */
  count: number;
  /** Model-facing reminder text (gentle at the first threshold, detailed after). */
  text: string;
};

/** One agent's consecutive-repeat chain: the last tracked call's identity key and its run length. */
type Chain = {
  key: string;
  count: number;
};

/** The gentle first-threshold reminder, keyed to `thresholds[0]` (not a literal count). */
const GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. ' +
  'Carefully analyze the previous result before calling again: if the task is ' +
  'not complete, try a different approach or different arguments instead of ' +
  'repeating the call.';

/** The detailed later-threshold reminder naming the tool, the run length, and the canonical arguments. */
function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return (
    'Repeated tool call detected:\n' +
    `- tool: ${toolName}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${canonicalArguments}\n` +
    'The repeated calls are not making progress. Do not call this tool with ' +
    'these exact arguments again. Inspect the latest result and choose a ' +
    'different action, different arguments, or finish the task if enough ' +
    'evidence has been gathered.'
  );
}

/**
 * Deep key-sort of a parsed-JSON value so two argument objects that differ only
 * in property order canonicalize identically. Arguments reach the tracker as a
 * plain JSON-domain value (or a raw string), so no bigint / cycle / `undefined`
 * handling is needed.
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).toSorted()) {
      sorted[key] = sortJsonValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue)) ?? 'null';
}

/**
 * Compile one `*`-wildcard pattern to an anchored, case-insensitive RegExp
 * (every other regex metacharacter is matched literally).
 */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`, 'i');
}

/**
 * Head-truncate the canonical arguments for quoting in the detailed reminder,
 * marking how much was omitted. Bounds only the model-visible text - the chain
 * key always uses the FULL canonical string.
 */
function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical;
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`;
}

/**
 * Validate `thresholds` per the fail-loud contract and return them sorted
 * ascending (the escalation rule reads `thresholds[0]` as the gentle tier).
 */
function validateThresholds(values: number[]): number[] {
  if (values.length === 0) {
    throw new Error('RepeatToolReminder: `thresholds` must not be empty');
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(`RepeatToolReminder: invalid threshold ${value} - every threshold must be an integer >= 2`);
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error('RepeatToolReminder: `thresholds` must not contain duplicates');
  }
  return values.toSorted((a, b) => a - b);
}

/**
 * Advisory per-agent repeat-tool-call tracker. Construct once per guard layer
 * and share it across the backend seam; key each `observe` call by the live
 * agent object (the WCore/ACP manager instance, or a session object) so chains
 * stay isolated per agent.
 */
export class RepeatToolReminder {
  private readonly thresholds: number[];
  private readonly thresholdSet: Set<number>;
  private readonly includePatterns: readonly RegExp[];
  private readonly excludePatterns: readonly RegExp[];
  private readonly argumentsPreviewChars: number;
  private readonly chains = new WeakMap<object, Chain>();

  constructor(config: RepeatReminderConfig = {}) {
    this.thresholds = validateThresholds(config.thresholds ?? [...DEFAULT_REPEAT_THRESHOLDS]);
    this.thresholdSet = new Set(this.thresholds);
    this.includePatterns = (config.include ?? []).map(wildcardToRegExp);
    this.excludePatterns = (config.exclude ?? [...DEFAULT_REPEAT_EXCLUDE]).map(wildcardToRegExp);

    const previewChars = config.argumentsPreviewChars ?? DEFAULT_ARGUMENTS_PREVIEW_CHARS;
    if (!Number.isInteger(previewChars) || previewChars < 1) {
      throw new Error(`RepeatToolReminder: invalid argumentsPreviewChars ${previewChars} - must be an integer >= 1`);
    }
    this.argumentsPreviewChars = previewChars;
  }

  /**
   * Whether a tool participates in the chain. Untracked calls are TRANSPARENT:
   * they neither increment nor reset the counter, so a bookkeeping tool
   * interleaved into a loop cannot launder it.
   */
  private tracked(toolName: string): boolean {
    if (this.includePatterns.length > 0 && !this.includePatterns.some((p) => p.test(toolName))) return false;
    return !this.excludePatterns.some((p) => p.test(toolName));
  }

  /**
   * Advance one agent's chain for a single tool attempt and return the reminder
   * to deliver, if this attempt's run length hits a configured threshold.
   *
   * Call this for EVERY attempt the model makes, including denied ones - a model
   * hammering a denied call is exactly the loop worth breaking. An untracked
   * tool is transparent (returns `undefined`, chain unchanged). Never throws.
   *
   * @param agent - the live agent object used to key this chain.
   * @param toolName - the tool being invoked.
   * @param args - the call's raw arguments (any JSON-domain value); canonicalized
   *   by deep key-sort so property order does not matter.
   */
  observe(agent: object, toolName: string, args: unknown): RepeatReminderNotice | undefined {
    if (!this.tracked(toolName)) return undefined;

    const canonical = canonicalize(args);
    const key = JSON.stringify([toolName, canonical]);
    const previous = this.chains.get(agent);
    const count = previous !== undefined && previous.key === key ? previous.count + 1 : 1;
    this.chains.set(agent, { key, count });

    if (!this.thresholdSet.has(count)) return undefined;

    const text =
      count === this.thresholds[0]
        ? GENTLE_REMINDER
        : detailedReminder(toolName, count, previewArguments(canonical, this.argumentsPreviewChars));
    return { toolName, count, text };
  }

  /**
   * Reset one agent's chain. Call when the context changes underneath the model
   * - a user interjection means repetition across it is not a loop. Idempotent;
   * safe to call for an agent with no chain yet.
   */
  reset(agent: object): void {
    this.chains.delete(agent);
  }
}
