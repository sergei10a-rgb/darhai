/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Last-resort bookkeeping for engine child processes, so quitting the app
 * cannot leave them running.
 *
 * The per-agent teardown already exists: `WorkerTaskManager.clear()` runs from
 * the quit cleanup and awaits each manager's `kill()`, which reaches
 * `WCoreAgent.kill()` / `AcpConnection.disconnect()` and finally `killChild`.
 * That is the graceful path and it handles the ordinary case.
 *
 * It is not sufficient on its own, for two reasons:
 *
 *  1. **The budget does not fit the work.** Each quit-cleanup step gets 2s, but
 *     one `killChild` alone can need 3s (POSIX SIGTERM grace) or 5s (the Windows
 *     `taskkill` timeout). An engine that is slow to die - or that ignores
 *     SIGTERM - is abandoned mid-kill when the step's budget elapses.
 *  2. **Not every child has a manager.** A child spawned outside a tracked
 *     manager is never reached by `clear()` at all.
 *
 * An abandoned engine child is not merely untidy on Windows: it keeps a handle
 * on files inside the install directory, which is what makes a later update or
 * uninstall fail to replace them.
 *
 * So every engine spawn registers here, entries remove themselves the moment
 * the process ends, and the quit cleanup finishes with one sweep over whatever
 * is somehow still in the map. When the graceful path worked - the common case
 * - the map is already empty and the sweep does nothing.
 */

import type { ChildProcess } from 'child_process';
import { execFileSync } from 'child_process';
import { isProcessAlive, killChild } from './acp/utils';

export type TrackedAgentChild = {
  readonly child: ChildProcess;
  readonly pid: number;
  /** What this process is, used only for logging (`wcore`, `acp:claude`, ...). */
  readonly label: string;
  /** Whether it was spawned detached, which decides how POSIX signals it. */
  readonly detached: boolean;
};

const tracked = new Map<number, TrackedAgentChild>();

/**
 * Track an engine child until it ends.
 *
 * Safe to call on a child with no pid (a spawn that failed before the OS gave
 * it one) - there is nothing to reap in that case.
 */
export function registerAgentChild(child: ChildProcess, options: { label: string; detached?: boolean }): void {
  const pid = child.pid;
  if (typeof pid !== 'number') return;

  tracked.set(pid, { child, pid, label: options.label, detached: options.detached ?? false });

  // Any of the three means the process is gone or unreachable. Listening to all
  // of them - rather than `exit` alone - is what keeps the map from growing
  // across a long session when a spawn fails or a stream errors out.
  const forget = () => {
    tracked.delete(pid);
  };
  child.once('exit', forget);
  child.once('close', forget);
  child.once('error', forget);
}

/** Stop tracking a pid. Callers that kill a child themselves may call this. */
export function unregisterAgentChild(pid: number | undefined): void {
  if (typeof pid === 'number') tracked.delete(pid);
}

/** How many engine children are currently tracked. Exposed for tests. */
export function trackedAgentChildCount(): number {
  return tracked.size;
}

/** Snapshot of the tracked children, for tests and diagnostics. */
export function listTrackedAgentChildren(): readonly TrackedAgentChild[] {
  return [...tracked.values()];
}

/** Drop all tracking without killing anything. Test-only. */
export function resetAgentChildRegistry(): void {
  tracked.clear();
}

export type ReapResult = {
  /** Children that were still running and got a kill sent to them. */
  reaped: number;
  /** Children whose kill threw. */
  failed: number;
};

/**
 * Kill every engine child that is somehow still running.
 *
 * Called once, at the end of the quit cleanup, after the graceful teardown has
 * had its turn. Never throws: a quit must not be blocked by a process that
 * refuses to die, and a failure here is strictly better reported than fatal.
 */
export async function reapOrphanedAgentChildren(): Promise<ReapResult> {
  const survivors = [...tracked.values()];
  tracked.clear();
  if (survivors.length === 0) return { reaped: 0, failed: 0 };

  console.warn(`[childRegistry] ${survivors.length} engine child(ren) survived teardown; reaping`);

  const outcomes = await Promise.allSettled(
    survivors.map(async (entry) => {
      // Ask the ChildProcess object, not just the pid. Node clears neither
      // field until it has reaped the process, so this is the one check that
      // cannot mistake a recycled pid for our long-dead child and kill a
      // stranger's process instead.
      const alreadyReaped = entry.child.exitCode !== null || entry.child.signalCode !== null;
      if (alreadyReaped || !isProcessAlive(entry.pid)) return false;

      await killChild(entry.child, entry.detached, entry.label);
      return true;
    })
  );

  let reaped = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      failed++;
      console.error('[childRegistry] reap failed:', outcome.reason);
    } else if (outcome.value) {
      reaped++;
    }
  }
  return { reaped, failed };
}

/** Longest a single synchronous `taskkill` may block the dying process. */
const SYNC_TASKKILL_TIMEOUT_MS = 2000;

/**
 * Kill surviving engine children from a `process.on('exit')` handler.
 *
 * `app.exit()` emits neither `before-quit` nor `will-quit`, so the async sweep
 * above never runs on the crash path, the init-failure path, or an externally
 * driven exit. Those are exactly the exits most likely to leave an engine
 * behind - and on Windows that engine keeps a handle inside the install
 * directory, which is what breaks the next update or uninstall.
 *
 * Everything here must be synchronous: a promise created in an `exit` handler
 * never gets a turn. That rules out the graceful SIGTERM-then-wait, so this
 * goes straight to a hard kill. The process is about to die either way.
 *
 * Normally a no-op - by this point the async sweep has already emptied the map.
 */
export function reapAgentChildrenSync(): number {
  const survivors = [...tracked.values()];
  tracked.clear();
  if (survivors.length === 0) return 0;

  let killed = 0;
  for (const entry of survivors) {
    // Same pid-reuse guard as the async path: never signal a pid Node has
    // already reaped, because it may belong to someone else by now.
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) continue;
    if (!isProcessAlive(entry.pid)) continue;

    try {
      if (process.platform === 'win32') {
        // Bounded, so a wedged taskkill cannot hold the dying process open.
        execFileSync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: SYNC_TASKKILL_TIMEOUT_MS,
          stdio: 'ignore',
        });
      } else {
        // Negative pid signals the whole group, which is why detached matters.
        process.kill(entry.detached ? -entry.pid : entry.pid, 'SIGKILL');
      }
      killed++;
    } catch (err) {
      // Never throw from an exit handler: it would replace the real exit
      // reason with this one.
      console.error(`[childRegistry] sync reap of ${entry.label} (${entry.pid}) failed:`, err);
    }
  }
  return killed;
}
