/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Windows batch-launcher adaptation for `spawn(..., { shell: false })`.
 *
 * Every CLI installed through npm/pnpm/yarn/bun on Windows lands on PATH as a
 * pair of shims - an extensionless sh script and a `.cmd` batch file - with the
 * real binary hidden inside `node_modules` and NOT on PATH. Neither shim can be
 * executed by `CreateProcess`:
 *
 *   spawn('opencode',      ['acp'], { shell: false }) -> ENOENT
 *   spawn('opencode.cmd',  ['acp'], { shell: false }) -> EINVAL
 *
 * The EINVAL is deliberate: Node refuses `.cmd`/`.bat` without a shell since
 * CVE-2024-27980, because Windows re-parses the command line for batch files
 * and an unescaped argument could inject commands. Both failures were measured
 * in the running app - `opencode` was offered in the agent picker and could
 * never start.
 *
 * The fix is to run the batch shim the documented way - through `cmd.exe` - but
 * without inheriting the CVE:
 *
 *   - `shell: true` is NOT used. Node builds that command line by naive string
 *     concatenation with no escaping at all, which is precisely the injection.
 *   - `cmd.exe` is invoked explicitly with `windowsVerbatimArguments: true`, so
 *     THIS module owns the exact command line, and every token is wrapped in
 *     double quotes (inside quotes cmd.exe does not treat `&`, `|`, `<`, `>`,
 *     `(`, `)` as operators).
 *   - The two constructs quoting cannot neutralise - an embedded `"` (which
 *     would end the quoted run) and `%VAR%` (which cmd.exe still expands inside
 *     quotes) - are REJECTED with a clear error rather than escaped by guesswork
 *     or silently mangled. A CLI path or argument containing them is not a case
 *     we can execute safely, and saying so beats running something else.
 *
 * Everything that is not a batch file is left completely untouched: real
 * executables keep being spawned directly with no shell involved.
 */

import { execFileSync } from 'child_process';
import path from 'path';

/** Extensions `CreateProcess` cannot launch: they require a command processor. */
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

/** Extensions that are directly executable, preferred when PATH offers a choice. */
const DIRECT_EXECUTABLE_EXTENSIONS = new Set(['.exe', '.com']);

/**
 * Characters a double-quoted cmd.exe token cannot carry safely.
 * `"` terminates the quoted run; `%` still triggers variable expansion inside
 * quotes; CR/LF would split the command line.
 */
const CMD_UNSAFE = /["%\r\n]/;

/** Resolution cache keyed by `command\u0000PATH`, so `where` runs once per pair. */
const resolvedLauncherCache = new Map<string, string | null>();

/** Extra spawn options a plan may require on top of the caller's own. */
export type WindowsLauncherOptions = { windowsVerbatimArguments?: true };

export type WindowsLauncherPlan = {
  command: string;
  args: string[];
  options: WindowsLauncherOptions;
};

/** True when `command` names a Windows batch file. */
export function isWindowsBatchLauncher(command: string): boolean {
  return BATCH_EXTENSIONS.has(path.extname(command).toLowerCase());
}

/** Clear the `where` cache (PATH changed, or a CLI was installed/removed). */
export function clearWindowsLauncherCache(): void {
  resolvedLauncherCache.clear();
}

/**
 * Resolve a bare command name against PATH, preferring a directly executable
 * candidate and falling back to a batch shim.
 *
 * Returns `null` when nothing usable is found, so the caller can leave the
 * command alone and let `spawn` report the real ENOENT.
 */
function resolveBareCommand(command: string, env: NodeJS.ProcessEnv): string | null {
  // Only plain command names reach here, but re-assert it: `where` takes a
  // pattern, and a caller-supplied string must never widen that into a search.
  if (!/^[a-zA-Z0-9_.-]+$/.test(command)) return null;

  const cacheKey = `${command}\u0000${env.PATH ?? ''}`;
  const cached = resolvedLauncherCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let candidates: string[] = [];
  try {
    const stdout = execFileSync('where', [command], {
      env,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    candidates = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // Not on PATH (or `where` unavailable) - nothing to adapt.
  }

  const direct = candidates.find((c) => DIRECT_EXECUTABLE_EXTENSIONS.has(path.extname(c).toLowerCase()));
  const batch = candidates.find((c) => isWindowsBatchLauncher(c));
  const resolved = direct ?? batch ?? null;

  resolvedLauncherCache.set(cacheKey, resolved);
  return resolved;
}

/** Quote one token for a verbatim cmd.exe command line, or refuse it. */
function quoteCmdToken(token: string, role: string): string {
  if (CMD_UNSAFE.test(token)) {
    throw new Error(
      `Cannot launch Windows batch shim: ${role} contains a character that cannot be quoted safely ` +
        `for cmd.exe (one of " % CR LF): ${JSON.stringify(token)}`
    );
  }
  return `"${token}"`;
}

/**
 * Build the explicit `cmd.exe` invocation for a batch shim.
 *
 * The whole command line is wrapped in one extra pair of quotes because
 * `cmd /c` strips the outermost quotes when the line both starts and ends with
 * one - without the wrapper, `"C:\...\opencode.cmd" "acp"` is re-read as the
 * single token `C:\...\opencode.cmd" "acp`, which cmd then cannot find.
 */
export function buildBatchLauncherPlan(batchPath: string, args: string[]): WindowsLauncherPlan {
  const tokens = [quoteCmdToken(batchPath, 'the CLI path'), ...args.map((a) => quoteCmdToken(a, 'an argument'))];
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${tokens.join(' ')}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/**
 * Adapt a `(command, args)` pair so a Windows batch shim actually runs.
 *
 * No-op on every other platform and for every directly executable target, so
 * the direct `shell: false` spawn stays the normal path.
 *
 * @throws when the target is a batch shim whose path/arguments cannot be quoted
 *   safely for cmd.exe. Failing loudly is intended: the alternative is guessing
 *   at an escape and executing something the caller did not ask for.
 */
export function adaptWindowsLauncher(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): WindowsLauncherPlan {
  const passthrough: WindowsLauncherPlan = { command, args, options: {} };
  if (process.platform !== 'win32' || !command) return passthrough;

  if (isWindowsBatchLauncher(command)) {
    return buildBatchLauncherPlan(command, args);
  }

  // A concrete path (has a separator or any other extension) is taken at face
  // value; only a bare name needs PATH resolution to learn what it really is.
  const looksLikePath = command.includes('/') || command.includes('\\') || path.extname(command) !== '';
  if (looksLikePath) return passthrough;

  const resolved = resolveBareCommand(command, env);
  if (!resolved || !isWindowsBatchLauncher(resolved)) return passthrough;

  return buildBatchLauncherPlan(resolved, args);
}
