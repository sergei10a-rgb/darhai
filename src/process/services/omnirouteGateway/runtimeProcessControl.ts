/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process mechanics for the Darhai-managed OmniRoute server: wait for the
 * spawned server to answer, kill the whole spawned TREE, and CONFIRM at the
 * socket level that the port was released.
 *
 * Split out of {@link OmnirouteRuntimeManager} so the manager stays a
 * lifecycle/state machine and this file owns the two things that used to be
 * wrong:
 *
 *  1. Escalation targeted the direct child only, which on Windows is `cmd.exe`
 *     - see {@link killProcessTree} for why that orphans the real server.
 *  2. "Stopped" was reported from the fact that a signal had been sent, never
 *     from the port actually going quiet. {@link waitForPortRelease} is the
 *     observable check: if something still answers, the caller must say so.
 */

import type { ChildProcessLike } from '@process/services/cookbook/LocalServeManager';
import type { KillTreeOutcome } from './killProcessTree';

/** How long to wait for a polite tree kill to land before forcing (ms). */
const GRACE_EXIT_MS = 1500;
/** How long to wait for the forced tree kill to land (ms). */
const FORCE_EXIT_MS = 1500;
/** Upper bound on waiting for the port to go quiet after a kill (ms). */
export const PORT_RELEASE_TIMEOUT_MS = 2000;
/** Interval between port-release probes (ms). */
const PORT_RELEASE_POLL_MS = 200;

/** Collaborators the shutdown path needs (injected, so tests stay hermetic). */
export type RuntimeProcessControlDeps = {
  /** Terminate a pid and every descendant it spawned. */
  killTree: (pid: number, force: boolean) => Promise<KillTreeOutcome>;
};

/** Interval between `/v1/models` polls while waiting for readiness (ms). */
const HEALTH_POLL_MS = 800;

/** What the readiness watcher needs from the manager. */
export type ServerReadyDeps = {
  /** Probe a URL; resolves true once it answers 2xx. */
  healthProbe: (url: string) => Promise<boolean>;
  /** The `/v1/models` URL that proves the server is up. */
  healthUrl: string;
  /** Readiness timeout fallback while the process is still alive (ms). */
  readyTimeoutMs: number;
  /** Relay one stdout/stderr chunk as progress. */
  onOutput: (chunk: string) => void;
  /** Called once if the child exits before it ever became healthy. */
  onEarlyExit: () => void;
};

/**
 * Resolve once the spawned server answers `healthUrl`; reject if it dies first
 * or never becomes healthy. The timeout fallback re-probes before giving up, so
 * a server that is up but slow to print a ready line still registers while a
 * wedged one does not.
 */
export function awaitServerReady(child: ChildProcessLike, deps: ServerReadyDeps): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let alive = true;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (err) reject(err);
      else resolve();
    };

    child.stdout?.on('data', (d) => deps.onOutput(d.toString()));
    child.stderr?.on('data', (d) => deps.onOutput(d.toString()));
    child.on('error', (...a) => finish((a[0] as unknown as Error) ?? new Error('spawn error')));
    child.on('exit', (...a) => {
      alive = false;
      deps.onEarlyExit();
      finish(new Error(`omniroute exited before readiness (code=${(a[0] as unknown as number | null) ?? null})`));
    });

    pollTimer = setInterval(() => {
      void deps.healthProbe(deps.healthUrl).then((ok) => {
        if (ok) finish();
      });
    }, HEALTH_POLL_MS);
    pollTimer.unref?.();

    fallbackTimer = setTimeout(() => {
      if (settled || !alive) return;
      void deps.healthProbe(deps.healthUrl).then((ok) => {
        finish(ok ? undefined : new Error('omniroute did not become healthy in time'));
      });
    }, deps.readyTimeoutMs);
    fallbackTimer.unref?.();
  });
}

/** A cancel-free sleep that never keeps the event loop alive. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Terminate `child` and its whole descendant tree.
 *
 * Escalates on EVIDENCE rather than on a fixed schedule: a polite kill that the
 * OS refuses (Windows `taskkill` without `/F` rejects console processes on the
 * spot) is escalated immediately instead of burning the grace window. The
 * caller still has to verify the port - a kill that "succeeded" says nothing
 * about a server Darhai never owned.
 */
export async function killTreeEscalating(child: ChildProcessLike, deps: RuntimeProcessControlDeps): Promise<void> {
  const pid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : null;
  let exited = false;
  const onExit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });

  const graceful = pid === null ? fallbackKill(child, false) : await deps.killTree(pid, false);
  if (graceful.ok) await Promise.race([onExit, delay(GRACE_EXIT_MS)]);
  else console.warn('[omnirouteGateway] polite tree kill refused, escalating now:', graceful.detail);
  if (exited) return;

  const forced = pid === null ? fallbackKill(child, true) : await deps.killTree(pid, true);
  if (!forced.ok) console.error('[omnirouteGateway] forced tree kill failed:', forced.detail);
  await Promise.race([onExit, delay(FORCE_EXIT_MS)]);
}

/** Last resort when the spawn never reported a pid: signal the handle itself. */
function fallbackKill(child: ChildProcessLike, force: boolean): KillTreeOutcome {
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  const ok = child.kill(signal);
  return { ok, detail: `child.kill(${signal}) without a pid -> ${String(ok)}` };
}

/**
 * Poll `healthUrl` until it stops answering.
 *
 * @returns true once the port is quiet, false if something is STILL serving
 *   when the timeout expires - which means the caller must not claim a stop.
 */
export async function waitForPortRelease(
  healthProbe: (url: string) => Promise<boolean>,
  healthUrl: string,
  timeoutMs: number = PORT_RELEASE_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await healthProbe(healthUrl))) return true;
    if (Date.now() >= deadline) return false;
    await delay(PORT_RELEASE_POLL_MS);
  }
}
