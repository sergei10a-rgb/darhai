/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OmniRoute runtime lifecycle manager (C2 one-click auto-install + run).
 *
 * Mirrors the cookbook lifecycle template: {@link LocalServeManager}'s spawn +
 * readiness-poll + SIGTERM->SIGKILL shutdown, and {@link ModelDownloadManager}'s
 * long-op-with-progress. It exists so a NON-TECHNICAL user gets a local OmniRoute
 * gateway without touching a terminal:
 *   1. {@link install}  - `<runtime> add/install -g omniroute@<pinned>` in the
 *      background, streaming installer stdout as progress.
 *   2. {@link start}    - spawn the `omniroute` bin headless (fixed port 20128),
 *      poll `GET /v1/models` until healthy.
 *   3. {@link openDashboard} - open OmniRoute's OWN dashboard so the USER connects
 *      a provider there.
 *   4. {@link stop} / {@link stopAll} - reap the whole process TREE (before-quit).
 *
 * TWO HONESTY RULES the state machine enforces, both of which it used to break:
 *  - OWNERSHIP. `start` probes the port first; a server that already answers is
 *    adopted as `owned: false`, never claimed as ours and never double-spawned.
 *  - STOPPING MEANS STOPPED. `stop` kills the whole descendant tree (killing the
 *    direct child leaves the grandchild holding the port on Windows) and then
 *    RE-PROBES: a port that still answers reports `external-server`, not
 *    `stopped`.
 *
 * LIABILITY BOUNDARY (enforced by design + unit test): this manager INSTALLS,
 * SPAWNS, HEALTH-CHECKS, and OPENS the dashboard - nothing else. It has NO
 * collaborator that could connect a free provider, register a provider, or
 * write OmniRoute's relay config, and it never imports the gateway service.
 * Turning the external relay ON stays the user's own Settings switch.
 *
 * Never throws to the caller: every failure is reflected in the returned
 * {@link OmnirouteRuntimeStatus}. Best-effort by design - if no runtime is
 * available it surfaces `needsRuntime` (the card shows a Node.js hint) rather
 * than crashing.
 */

import {
  OMNIROUTE_DASHBOARD_URL,
  OMNIROUTE_HEALTH_URL,
  OMNIROUTE_PINNED_PACKAGE,
  OMNIROUTE_RUNTIME_PORT,
  type OmnirouteInstallProgress,
  type OmnirouteRuntimeKind,
  type OmnirouteRuntimeStatus,
} from '@/common/types/omnirouteGateway';
import type { ChildProcessLike } from '@process/services/cookbook/LocalServeManager';
import type { KillTreeOutcome } from './killProcessTree';
import { awaitServerReady, killTreeEscalating, waitForPortRelease } from './runtimeProcessControl';

/** Spawn options the manager passes down (superset of the cookbook shape). */
export type OmnirouteSpawnOptions = {
  stdio: ['ignore', 'pipe', 'pipe'];
  env: Record<string, string>;
  shell?: boolean;
  windowsHide?: boolean;
  /**
   * POSIX only: put the server in its own process GROUP so the whole tree can
   * be signalled at once. Windows uses `taskkill /T` instead (a detached child
   * there would only hide the console window, not help the kill).
   */
  detached?: boolean;
};

/** Injectable collaborators - production defaults are wired in the singleton. */
export type OmnirouteRuntimeDeps = {
  /** Spawn a child process. */
  spawn: (cmd: string, args: string[], opts: OmnirouteSpawnOptions) => ChildProcessLike;
  /** Probe a URL; resolves true once it answers 2xx. */
  healthProbe: (url: string) => Promise<boolean>;
  /** Open a URL in the user's default browser (prod: shell.openExternal). */
  openUrl: (url: string) => Promise<void>;
  /** Enhanced child-process environment. */
  env: () => Record<string, string>;
  /** Absolute path of the bundled bun binary, or null when unavailable. */
  bundledBunPath: () => string | null;
  /** Resolve an executable on PATH (or verify an absolute path). */
  resolveCommandPath: (cmd: string) => string | null;
  /** Candidate absolute paths a globally-installed `omniroute` bin may live at. */
  omnirouteBinCandidates: () => string[];
  /** Readiness timeout fallback while the process is still alive (ms). */
  readyTimeoutMs: number;
  /** Windows shell-exec options (`.cmd` shims); `{}` off Windows. */
  spawnShellOptions: () => { shell?: boolean; windowsHide?: boolean };
  /** Terminate a pid AND every descendant it spawned (never the direct child alone). */
  killTree: (pid: number, force: boolean) => Promise<KillTreeOutcome>;
  /** Optional status emitter (prod: IPC `on-runtime-status`). */
  onStatus?: (status: OmnirouteRuntimeStatus) => void;
  /** Optional progress emitter (prod: IPC `on-install-progress`). */
  onProgress?: (progress: OmnirouteInstallProgress) => void;
};

/** Keep at most this many trailing chars of an installer line (progress noise). */
const MAX_PROGRESS_LINE = 240;

/** A resolved runtime: which kind + the executable + its global-install args. */
type ResolvedRuntime = { kind: OmnirouteRuntimeKind; exec: string; installArgs: string[] };

/** A located `omniroute` bin plus the runtime kind it was installed by. */
type ResolvedBin = { bin: string; kind: OmnirouteRuntimeKind };

const IDLE_STATUS: OmnirouteRuntimeStatus = {
  state: 'idle',
  port: null,
  dashboardUrl: null,
  runtime: null,
  needsRuntime: false,
  owned: false,
};

export class OmnirouteRuntimeManager {
  private process: ChildProcessLike | null = null;
  private status: OmnirouteRuntimeStatus = { ...IDLE_STATUS };
  private runtimeKind: OmnirouteRuntimeKind | null = null;
  private startPromise: Promise<OmnirouteRuntimeStatus> | null = null;
  private readonly deps: OmnirouteRuntimeDeps;

  constructor(deps: OmnirouteRuntimeDeps) {
    this.deps = deps;
  }

  /** Current runtime snapshot. */
  getStatus(): OmnirouteRuntimeStatus {
    return this.status;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Install OmniRoute globally through the resolved runtime (bundled bun first,
   * then system node/npm). Streams installer stdout as progress. Never throws -
   * a missing runtime resolves to an `error` status with `needsRuntime: true`
   * (the card then shows the "install Node.js" hint).
   */
  async install(onProgress?: (p: OmnirouteInstallProgress) => void): Promise<OmnirouteRuntimeStatus> {
    const runtime = this.resolveRuntime();
    if (!runtime) {
      return this.setStatus({ state: 'error', runtime: null, needsRuntime: true, error: 'no-runtime' });
    }
    this.runtimeKind = runtime.kind;
    this.setStatus({ state: 'installing', runtime: runtime.kind, needsRuntime: false, error: undefined });
    try {
      await this.runToCompletion(runtime.exec, runtime.installArgs, 'install', onProgress);
    } catch (err) {
      return this.setStatus({ state: 'error', error: this.errText(err) });
    }
    return this.setStatus({ state: 'installed', runtime: runtime.kind });
  }

  /**
   * Spawn the installed `omniroute` bin headless on the fixed loopback port and
   * wait for `GET /v1/models` to answer. Never throws - a missing bin resolves
   * to `error: 'not-installed'`; an early exit resolves to `error`.
   */
  async start(onProgress?: (p: OmnirouteInstallProgress) => void): Promise<OmnirouteRuntimeStatus> {
    if (this.isRunning) return this.status;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart(onProgress);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(onProgress?: (p: OmnirouteInstallProgress) => void): Promise<OmnirouteRuntimeStatus> {
    // Preflight: something already serving the port means Darhai did NOT start
    // it. Adopt it (it is a usable gateway either way) but mark it unowned, so
    // neither the card nor stop() pretends this process is ours to control.
    if (await this.deps.healthProbe(OMNIROUTE_HEALTH_URL)) {
      this.emitProgress('health', 'omniroute already serving port 20128 (not started by Darhai)', onProgress);
      return this.setStatus({
        state: 'running',
        port: OMNIROUTE_RUNTIME_PORT,
        dashboardUrl: OMNIROUTE_DASHBOARD_URL,
        runtime: this.runtimeKind,
        needsRuntime: false,
        owned: false,
        error: undefined,
      });
    }
    const resolved = this.resolveOmnirouteBin();
    if (!resolved) {
      return this.setStatus({ state: 'error', error: 'not-installed', owned: false });
    }
    // The runtime label must reflect what START used, not only what install()
    // happened to set: "already installed" is the common path and it never
    // calls install(), which is why the card used to render a blank runtime.
    this.runtimeKind = resolved.kind;
    this.setStatus({ state: 'starting', runtime: resolved.kind, error: undefined, owned: false });
    try {
      await this.launch(resolved.bin, onProgress);
    } catch (err) {
      // A readiness timeout leaves a LIVE server behind. Reap the tree here or
      // it holds port 20128 for the rest of the machine's uptime with nothing
      // left to stop it - the exact leak the audit caught.
      await this.killProcess();
      return this.setStatus({ state: 'error', error: this.errText(err), owned: false });
    }
    return this.setStatus({
      state: 'running',
      port: OMNIROUTE_RUNTIME_PORT,
      dashboardUrl: OMNIROUTE_DASHBOARD_URL,
      runtime: this.runtimeKind,
      needsRuntime: false,
      owned: true,
      error: undefined,
    });
  }

  /**
   * Open OmniRoute's OWN dashboard in the user's browser. This is where the USER
   * connects a free provider - Darhai never does that step. Never throws.
   */
  async openDashboard(): Promise<{ ok: boolean }> {
    try {
      await this.deps.openUrl(OMNIROUTE_DASHBOARD_URL);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Stop the running server and PROVE the port came free.
   *
   * Killing the tree is only half of it: the returned status is derived from a
   * re-probe of port 20128, never from "a signal was sent". A port that still
   * answers is reported as `running` + `external-server` - a server Darhai does
   * not own cannot be stopped by Darhai, and saying "stopped" there is the lie
   * this method exists to avoid.
   */
  async stop(): Promise<OmnirouteRuntimeStatus> {
    const hadOwnProcess = this.process !== null;
    await this.killProcess();
    const released = await waitForPortRelease(this.deps.healthProbe, OMNIROUTE_HEALTH_URL);
    if (!released) {
      return this.setStatus({
        state: 'running',
        port: OMNIROUTE_RUNTIME_PORT,
        dashboardUrl: OMNIROUTE_DASHBOARD_URL,
        owned: false,
        error: hadOwnProcess ? 'stop-port-still-served' : 'external-server',
      });
    }
    return this.setStatus({ state: 'stopped', port: null, dashboardUrl: null, owned: false, error: undefined });
  }

  /**
   * BLOCKING last-resort reaper for app quit.
   *
   * Electron does not await async `before-quit` handlers, so {@link stopAll} -
   * however correct - can be cut off before its kill lands, and the OmniRoute
   * tree then outlives the app holding port 20128 (measured: 23ms between
   * `before-quit` and `will-quit`, server still LISTENING afterwards). This
   * hands the pid to a synchronous killer that the quit sequence cannot
   * interrupt, and drops the handle so a later stopAll is a no-op.
   *
   * @param killSync must block until the tree is gone (injected so this class
   *   still owns no process API of its own).
   */
  reapOnQuitSync(killSync: (pid: number) => void): void {
    const child = this.process;
    if (!child) return;
    this.process = null;
    const pid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : null;
    if (pid === null) {
      child.kill('SIGKILL');
      return;
    }
    killSync(pid);
  }

  /**
   * Stop everything for app quit. A spawned OmniRoute (Next.js) server MUST be
   * killed - tree and all - or it leaks and holds the port after the app quits.
   * Wired into the before-quit CleanupModules bundle next to cookbook's stopAll.
   *
   * Deliberately skips stop()'s port re-probe: before-quit runs on a 2s per-step
   * budget and there is nothing left to react with. The kill itself is issued
   * through the identical {@link killProcess} path, so it is exactly as thorough.
   */
  async stopAll(): Promise<void> {
    await this.killProcess();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Prefer the bundled bun; else fall back to system npm/node. */
  private resolveRuntime(): ResolvedRuntime | null {
    const bun = this.deps.bundledBunPath();
    if (bun) {
      // `bun add -g <pkg>` installs a global package + its bin into ~/.bun/bin.
      return { kind: 'bun', exec: bun, installArgs: ['add', '-g', OMNIROUTE_PINNED_PACKAGE] };
    }
    const npm = this.deps.resolveCommandPath('npm') ?? this.deps.resolveCommandPath('npm.cmd');
    if (npm) {
      return { kind: 'node', exec: npm, installArgs: ['install', '-g', OMNIROUTE_PINNED_PACKAGE] };
    }
    return null;
  }

  /**
   * Locate a runnable global `omniroute` bin among the candidates + PATH, and
   * report WHICH runtime put it there. The candidates are bun's global bin dir
   * (`bun add -g` drops shims there), so a hit means bun; falling through to a
   * bare PATH lookup means the npm/node global install.
   */
  private resolveOmnirouteBin(): ResolvedBin | null {
    for (const candidate of this.deps.omnirouteBinCandidates()) {
      const found = this.deps.resolveCommandPath(candidate);
      if (found) return { bin: found, kind: 'bun' };
    }
    const onPath = this.deps.resolveCommandPath('omniroute');
    return onPath ? { bin: onPath, kind: 'node' } : null;
  }

  /** Spawn a command and resolve on exit 0 (install path). */
  private runToCompletion(
    exec: string,
    args: string[],
    phase: OmnirouteInstallProgress['phase'],
    onProgress?: (p: OmnirouteInstallProgress) => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcessLike;
      try {
        child = this.deps.spawn(exec, args, this.spawnOpts(this.deps.env()));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const relay = (data: Buffer | string): void => this.emitProgress(phase, data.toString(), onProgress);
      child.stdout?.on('data', relay);
      child.stderr?.on('data', relay);
      child.on('error', (...a) => reject((a[0] as unknown as Error) ?? new Error('spawn error')));
      child.on('exit', (...a) => {
        const code = (a[0] as unknown as number | null) ?? null;
        if (code === 0) resolve();
        else reject(new Error(`omniroute install exited with code ${code}`));
      });
    });
  }

  /** Spawn the server + resolve once healthy (mirrors LocalServeManager.launch). */
  private async launch(bin: string, onProgress?: (p: OmnirouteInstallProgress) => void): Promise<void> {
    const env: Record<string, string> = {
      ...this.deps.env(),
      PORT: String(OMNIROUTE_RUNTIME_PORT),
      HOST: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
    };
    let child: ChildProcessLike;
    try {
      child = this.deps.spawn(bin, [], this.spawnOpts(env, true));
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.process = child;

    await awaitServerReady(child, {
      healthProbe: this.deps.healthProbe,
      healthUrl: OMNIROUTE_HEALTH_URL,
      readyTimeoutMs: this.deps.readyTimeoutMs,
      onOutput: (chunk) => this.emitProgress('start', chunk, onProgress),
      onEarlyExit: () => {
        this.process = null;
      },
    });
    this.emitProgress('health', 'omniroute healthy', onProgress);
  }

  /**
   * Reap the spawned server and EVERY process it started.
   *
   * `this.process` is cleared up front so a concurrent stop/quit cannot kill the
   * same tree twice, and so a failed kill can never leave the manager believing
   * it still controls a process it does not.
   */
  private async killProcess(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = null;
    await killTreeEscalating(child, { killTree: this.deps.killTree });
  }

  /**
   * @param detach only the long-lived SERVER needs its own POSIX process group
   *   (so `kill(-pid)` reaches the forks it makes). The installer is a
   *   short-lived foreground command and stays attached.
   */
  private spawnOpts(env: Record<string, string>, detach = false): OmnirouteSpawnOptions {
    return {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      ...(detach && process.platform !== 'win32' ? { detached: true } : {}),
      ...this.deps.spawnShellOptions(),
    };
  }

  private emitProgress(
    phase: OmnirouteInstallProgress['phase'],
    raw: string,
    onProgress?: (p: OmnirouteInstallProgress) => void
  ): void {
    const message = raw.replace(/\s+$/, '').slice(-MAX_PROGRESS_LINE);
    if (message.length === 0) return;
    const progress: OmnirouteInstallProgress = { phase, message };
    this.deps.onProgress?.(progress);
    onProgress?.(progress);
  }

  private setStatus(partial: Partial<OmnirouteRuntimeStatus>): OmnirouteRuntimeStatus {
    this.status = { ...this.status, ...partial };
    this.deps.onStatus?.(this.status);
    return this.status;
  }

  private errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
