/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Types for the native pre-tool guard. The guard sits in front of Darhai's own
 * agent approval seams (WCore / ACP) and evaluates a normalized (toolName,
 * input) tuple, returning allow / deny / warn. It is a pure, synchronous,
 * regex-only evaluator - no I/O, no external process - so it can run inline at
 * the approval boundary before any auto-approve or "always allow" cache.
 *
 * This is NOT the ECC shell-hook path (`ecc.gateGuardEnabled`): ECC hooks are
 * run by the Claude Code CLI and never apply to Darhai's WCore / ACP / Gemini
 * backends. This guard is the native equivalent for those backends.
 */

/** When the guard runs relative to tool execution. Only `pre` is wired today. */
export type GuardEvent = 'pre' | 'post';

/** The verdict a rule (and the overall evaluation) can produce. */
export type GuardAction = 'allow' | 'deny' | 'warn';

/**
 * Backend-agnostic view of a tool call. Each backend's own tool shape is mapped
 * into this by `normalize.ts` so the rules run identically for WCore and ACP.
 */
export type NormalizedTool = {
  /** Tool name / title (ACP `toolCall.title`, WCore `tool.name`). */
  toolName: string;
  /** ACP `toolCall.kind` (`read` | `edit` | `execute`), when present. */
  kind?: string;
  /** WCore `tool.category` (`info` | `edit` | `exec` | `mcp`), when present. */
  category?: string;
  /** Shell command string, for exec-style tools. */
  command?: string;
  /** Target file path, for edit / read tools. */
  filePath?: string;
  /** New file content, for write / edit tools. */
  content?: string;
};

/**
 * A single guard rule. A rule matches only when EVERY provided pattern matches
 * its corresponding normalized field (logical AND); a rule with no pattern at
 * all matches nothing (never a blanket match). Patterns are regex sources
 * compiled case-insensitively.
 */
export type GuardRule = {
  id: string;
  event: GuardEvent;
  action: GuardAction;
  /** Regex source matched against `toolName`. */
  tool?: string;
  /** Regex source matched against `command`. */
  commandPattern?: string;
  /** Regex source matched against `filePath`. */
  pathPattern?: string;
  /** Regex source matched against `content`. */
  contentPattern?: string;
  /** Human-readable reason surfaced on a match (deny reason / warn tip). */
  message?: string;
};

/** The result of evaluating a normalized tool against a ruleset. */
export type GuardVerdict = {
  action: GuardAction;
  /** Id of the rule that produced a deny / warn (absent for a plain allow). */
  ruleId?: string;
  /** The matched rule's message, for surfacing to the user / model. */
  message?: string;
};
