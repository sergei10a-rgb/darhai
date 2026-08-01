/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Kill a spawned process AND every descendant it started.
 *
 * Signalling the direct child is NOT enough for OmniRoute, on any platform:
 *
 *  - Windows: {@link getWindowsShellExecutionOptions} sets `shell: true` so the
 *    npm/bun `.cmd` shim can run, which makes the direct child `cmd.exe`.
 *    `cmd.exe` spawns `node bin/omniroute.mjs`, which spawns
 *    `node dist/server-ws.mjs` - and THAT grandchild is the one holding port
 *    20128. Killing `cmd.exe` orphans the pair; Windows does not cascade
 *    signals, so the port stays bound until the machine reboots or someone
 *    kills the pids by hand.
 *  - POSIX: no shell wrapper, but `omniroute` still forks its own server, so a
 *    plain SIGTERM to the direct child leaves the fork behind. The manager
 *    therefore spawns detached (a new process GROUP) and this helper signals
 *    the whole group with `kill(-pid)`.
 *
 * The helper is deliberately pid-based and returns the OUTCOME instead of
 * swallowing it: the caller escalates the moment a graceful attempt reports
 * failure (on Windows `taskkill` without `/F` refuses console processes
 * immediately, so waiting out a grace window there would be dead time), and
 * verifies the real result by probing the port afterwards.
 *
 * Related: {@link killChild} in `src/process/agent/acp/utils.ts` does the same
 * job for ACP agents but takes a full `ChildProcess` and owns its own
 * escalation loop, which this manager cannot use (its child is an injectable
 * {@link ChildProcessLike} and the escalation is driven by port readiness).
 */

import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** Upper bound on a single `taskkill` invocation (ms). */
const TASKKILL_TIMEOUT_MS = 5000;

/** Outcome of one kill attempt - `ok` means the OS accepted it (or nothing was left). */
export type KillTreeOutcome = { ok: boolean; detail: string };

/**
 * Absolute `taskkill.exe` inside the real System32, so the kill cannot be
 * hijacked by a `taskkill.exe` planted earlier on PATH. Falls back to the bare
 * name only when the expected location is missing.
 */
function taskkillPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const absolute = path.join(systemRoot, 'System32', 'taskkill.exe');
  return existsSync(absolute) ? absolute : 'taskkill';
}

/** Human-readable text for an unknown throw. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Windows: `taskkill /PID <pid> /T [/F]` terminates the pid and its whole tree. */
async function killTreeWindows(pid: number, force: boolean): Promise<KillTreeOutcome> {
  const args = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'];
  try {
    await execFile(taskkillPath(), args, { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS });
    return { ok: true, detail: `taskkill ${args.join(' ')}` };
  } catch (err) {
    // Two very different failures share this branch, and both must escalate
    // rather than be treated as "done": a console process refusing a graceful
    // close ("can only be terminated forcefully"), and a pid that is already
    // gone ("not found"). The caller re-probes the port either way.
    return { ok: false, detail: `taskkill ${args.join(' ')} failed: ${errText(err)}` };
  }
}

/**
 * POSIX: signal the process GROUP (`kill(-pid)`), which reaches every fork the
 * server made. Falls back to the single pid when the group does not exist -
 * that happens when the child was not spawned detached.
 */
function killTreePosix(pid: number, force: boolean): KillTreeOutcome {
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, signal);
    return { ok: true, detail: `kill -${signal} -${pid}` };
  } catch (groupErr) {
    try {
      process.kill(pid, signal);
      return { ok: true, detail: `kill -${signal} ${pid} (no process group)` };
    } catch (pidErr) {
      const gone = (pidErr as NodeJS.ErrnoException)?.code === 'ESRCH';
      // ESRCH = the process is already gone, which IS the outcome we wanted.
      return gone
        ? { ok: true, detail: `pid ${pid} already exited` }
        : { ok: false, detail: `kill ${pid} failed: ${errText(groupErr)} / ${errText(pidErr)}` };
    }
  }
}

/**
 * Terminate `pid` and every process it spawned.
 *
 * @param force `false` asks politely (SIGTERM / `taskkill /T`), `true` is
 *   unconditional (SIGKILL / `taskkill /T /F`).
 */
export async function killProcessTree(pid: number, force: boolean): Promise<KillTreeOutcome> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, detail: `refusing to kill invalid pid ${String(pid)}` };
  }
  return process.platform === 'win32' ? killTreeWindows(pid, force) : killTreePosix(pid, force);
}

/**
 * The same forced tree kill, but BLOCKING - the only form that survives app
 * quit.
 *
 * Electron does not await async `before-quit` handlers. Measured on this build:
 * `[Wayland] before-quit` and `[Wayland] will-quit` are 23ms apart, so an
 * awaited cleanup step is cut off mid-flight and the OmniRoute tree outlives
 * the app (netstat kept showing `127.0.0.1:20128 LISTENING` after the Electron
 * pid was gone). A synchronous kill inside the handler cannot be cut short.
 *
 * Reserved for quit - everywhere else the async form keeps the main process
 * responsive.
 */
export function killProcessTreeSync(pid: number, timeoutMs = TASKKILL_TIMEOUT_MS): KillTreeOutcome {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, detail: `refusing to kill invalid pid ${String(pid)}` };
  }
  if (process.platform !== 'win32') return killTreePosix(pid, true);
  const args = ['/PID', String(pid), '/T', '/F'];
  try {
    execFileSync(taskkillPath(), args, { windowsHide: true, timeout: timeoutMs, stdio: 'ignore' });
    return { ok: true, detail: `taskkill ${args.join(' ')}` };
  } catch (err) {
    return { ok: false, detail: `taskkill ${args.join(' ')} failed: ${errText(err)}` };
  }
}
