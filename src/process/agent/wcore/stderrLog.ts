/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Classify engine stderr so it is logged at the right level instead of every
 * line landing on console.error. The engine writes ordinary progress/info to
 * stderr (a common Rust/tracing default), so blanket console.error turned
 * benign diagnostics into red noise that buried the lines that actually matter.
 *
 * Ported from upstream 49a49fcd9.
 */

/** Strip ANSI SGR / color escape sequences the engine may emit for a TTY. */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\[[0-9;]*m/g, '');
}

export type StderrLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Pick a console level for one stderr line. The engine's `tracing` output is
 * prefixed with a level token (e.g. `ERROR`, `WARN`, `INFO`, `DEBUG`/`TRACE`);
 * match it case-insensitively. Lines with no recognizable level default to
 * `info` (progress noise), NOT error - the whole point of the fix.
 */
export function wcoreStderrLevel(line: string): StderrLevel {
  const s = stripAnsi(line);
  if (/\b(ERROR|FATAL|PANIC)\b/i.test(s)) return 'error';
  if (/\bWARN(ING)?\b/i.test(s)) return 'warn';
  if (/\b(DEBUG|TRACE)\b/i.test(s)) return 'debug';
  return 'info';
}
