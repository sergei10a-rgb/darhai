/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RTK (Token Killer) - strip terminal/tool-output noise from text while keeping
 * every line that carries signal.
 *
 * It removes ANSI/VT escape sequences, collapses carriage-return progress
 * redraws down to their final rendered state, drops spinner / progress-bar /
 * box-drawing "chrome" lines, and squeezes runs of blank lines - but PRESERVES
 * any line that looks like an error, warning, stack-trace frame, or a final
 * summary. Pure, deterministic, dependency-free, and idempotent.
 *
 * Two entry points:
 *   - `rtk`         - the full, lossy cleanup (used by balanced/aggressive).
 *   - `rtkLossless` - the safe subset (ANSI + insignificant whitespace only)
 *                     that never removes a visible glyph (used by lite).
 */

/**
 * Canonical ANSI escape matcher (CSI colour/cursor sequences + OSC strings
 * terminated by BEL). Escape codes are display-only control bytes, never
 * content, so removing them is safe in every mode.
 */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

/** Braille block - the range terminal spinners draw from. */
const BRAILLE = '\\u2800-\\u28FF';
/** Box-drawing characters (borders, table rules drawn by TUIs). */
const BOX_DRAWING = '\\u2500-\\u257F';
/** Block elements (progress-bar fills). */
const BLOCK = '\\u2580-\\u259F';

const BRAILLE_PREFIX = new RegExp(`^[${BRAILLE}]`);
const CHROME_CHARS = new RegExp(`[${BOX_DRAWING}${BLOCK}]`, 'g');
const PURE_CHROME_LINE = new RegExp(`^[${BOX_DRAWING}${BLOCK}\\s]+$`);
/** `[####----] 42%` style ASCII progress bars. */
const ASCII_PROGRESS_BAR = /^[[(][#=\->.\s]{2,}[)\]]\s*\d{1,3}\s*%$/;

/**
 * Lines that must never be dropped as noise: errors, warnings, stack-trace
 * frames, and final summaries. Kept deliberately broad - preserving a line is
 * always safe (it only forgoes some savings), dropping a real one is not.
 */
const PRESERVE_LINE =
  /\b(?:error|errors|err|fail|failed|failure|failing|fails|warn|warning|warnings|exception|exceptions|panic|fatal|traceback|assert|assertion|denied|refused|timeout|timed\s*out|unable|cannot|missing|invalid|unexpected|undefined|segfault|stacktrace)\b|^\s*at\s+\S|^\s+File\s+"|^\s*Caused by|\b(?:pass|passed|passing|ok|success|succeeded|done|complete|completed|finished|built|total|summary|coverage|result|results)\b|[✓✔✗✘❌⚠]/i;

/** Remove every ANSI/VT escape sequence. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Collapse a carriage-return progress redraw: a terminal line rewritten with
 * `\r` renders only whatever follows the LAST `\r`, so keep that tail.
 */
function collapseCarriageReturns(line: string): string {
  const idx = line.lastIndexOf('\r');
  return idx === -1 ? line : line.slice(idx + 1);
}

/** True when a line is pure terminal chrome (spinner / progress bar / border). */
function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false; // blank lines are handled by blank-collapse
  if (PRESERVE_LINE.test(line)) return false;

  // Spinner status line: begins with a braille glyph.
  if (BRAILLE_PREFIX.test(trimmed)) return true;

  // Border / progress-bar line dominated by box-drawing or block characters.
  const chromeCount = (trimmed.match(CHROME_CHARS) ?? []).length;
  const nonSpace = trimmed.replace(/\s/g, '').length;
  if (nonSpace >= 3 && chromeCount / nonSpace >= 0.5) return true;

  // A line made only of box/block characters (a plain border).
  if (PURE_CHROME_LINE.test(trimmed)) return true;

  // An explicit ASCII progress bar with a percentage.
  if (ASCII_PROGRESS_BAR.test(trimmed)) return true;

  return false;
}

/** Trim insignificant end-of-line whitespace (before a newline or EOF). */
function trimLineEnds(text: string): string {
  return text.replace(/[ \t]+(?=\n|$)/g, '');
}

/** Collapse three-or-more consecutive newlines to a single blank line. */
function collapseBlankRuns(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Lossless subset used by the `lite` mode: strip ANSI escapes and normalize only
 * insignificant whitespace (trailing spaces/tabs, excess blank lines). Never
 * touches a visible glyph, so the sequence of non-whitespace characters is
 * preserved exactly - no code token, URL, or JSON value can change. Idempotent.
 */
export function rtkLossless(text: string): string {
  let out = stripAnsi(text);
  out = trimLineEnds(out);
  out = collapseBlankRuns(out);
  return out;
}

/**
 * Full RTK cleanup for balanced/aggressive modes: ANSI strip, carriage-return
 * collapse, terminal-chrome line removal, trailing-whitespace trim, blank-run
 * collapse. Preserves error / warning / stack / summary lines. Idempotent.
 */
export function rtk(text: string): string {
  let out = text.replace(/\r\n/g, '\n');
  out = stripAnsi(out);
  out = out
    .split('\n')
    .map(collapseCarriageReturns)
    .filter((line) => !isNoiseLine(line))
    .join('\n');
  out = trimLineEnds(out);
  out = collapseBlankRuns(out);
  return out;
}
