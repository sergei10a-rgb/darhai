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
 *   4. {@link stop} / {@link stopAll} - reap the process (before-quit).
 *
 * LIABILITY BOUNDARY (enforced by design + unit test): this manager INSTALLS,
 * SPAWNS, HEALTH-CHECKS, and OPENS the dashboard - nothing else. It has NO
 * collaborator that could connect a free provider or write OmniRoute's
 * provider/relay config, and it never imports the gateway service. Pointing
 * Darhai's own `omniroute-gateway` provider at localhost:20128/v1 (via
 * applyOmnirouteGatewayConfig) is done OUTSIDE this manager, in the bridge, once
 * health is green - that only registers Darhai's gateway, it never connects a
 * provider on the user's behalf.
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

/** Spawn options the manager passes down (superset of the cookbook shape). */
export type OmnirouteSpawnOptions = {
  stdio: ['ignore', 'pipe', 'pipe'];
  env: Record<string, string>;
  shell?: boolean;
  windowsHide?: boolean;
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
  /** Optional status emitter (prod: IPC `on-runtime-status`). */
  onStatus?: (status: OmnirouteRuntimeStatus) => void;
  /** Optional progress emitter (prod: IPC `on-install-progress`). */
  onProgress?: (progress: OmnirouteInstallProgress) => void;
};

/** Interval between `/v1/models` polls while waiting for readiness (ms). */
const HEALTH_POLL_MS = 800;
/** SIGTERM -> SIGKILL escalation window (ms). */
const FORCE_KILL_MS = 5000;
/** Default readiness timeout fallback (ms) - a Next.js cold start is slow. */
const DEFAULT_READY_TIMEOUT_MS = 30000;
/** Keep at most this many trailing chars of an installer line (progress noise). */
const MAX_PROGRESS_LINE = 240;

/** A resolved runtime: which kind + the executable + its global-install args. */
type ResolvedRuntime = { kind: OmnirouteRuntimeKind; exec: string; installArgs: string[] };

const IDLE_STATUS: OmnirouteRuntimeStatus = {
  state: 'idle',
  port: null,
  dashboardUrl: null,
  runtime: null,
  needsRuntime: false,
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
    const bin = this.resolveOmnirouteBin();
    if (!bin) {
      return this.setStatus({ state: 'error', error: 'not-installed' });
    }
    this.setStatus({ state: 'starting', runtime: this.runtimeKind, error: undefined });
    try {
      await this.launch(bin, onProgress);
    } catch (err) {
      this.process = null;
      return this.setStatus({ state: 'error', error: this.errText(err) });
    }
    return this.setStatus({
      state: 'running',
      port: OMNIROUTE_RUNTIME_PORT,
      dashboardUrl: OMNIROUTE_DASHBOARD_URL,
      runtime: this.runtimeKind,
      needsRuntime: false,
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

  /** Stop the running server: SIGTERM, then SIGKILL after {@link FORCE_KILL_MS}. */
  async stop(): Promise<OmnirouteRuntimeStatus> {
    await this.killProcess();
    return this.setStatus({ state: 'stopped', port: null, dashboardUrl: null });
  }

  /**
   * Stop everything for app quit. A spawned OmniRoute (Next.js) server MUST be
   * killed or it leaks and holds the port after the app quits. Wired into the
   * before-quit CleanupModules bundle next to cookbook's stopAll.
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

  /** Locate a runnable global `omniroute` bin among the candidates + PATH. */
  private resolveOmnirouteBin(): string | null {
    for (const candidate of this.deps.omnirouteBinCandidates()) {
      const found = this.deps.resolveCommandPath(candidate);
      if (found) return found;
    }
    return this.deps.resolveCommandPath('omniroute');
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
  private launch(bin: string, onProgress?: (p: OmnirouteInstallProgress) => void): Promise<void> {
    const env: Record<string, string> = {
      ...this.deps.env(),
      PORT: String(OMNIROUTE_RUNTIME_PORT),
      HOST: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
    };
    let child: ChildProcessLike;
    try {
      child = this.deps.spawn(bin, [], this.spawnOpts(env));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    this.process = child;

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (pollTimer) clearInterval(pollTimer);
        if (fallbackTimer) clearTimeout(fallbackTimer);
      };
      const ready = (): void => {
        if (resolved) return;
        resolved = true;
        cleanup();
        this.emitProgress('health', 'omniroute healthy', onProgress);
        resolve();
      };

      child.stdout?.on('data', (d) => this.emitProgress('start', d.toString(), onProgress));
      child.stderr?.on('data', (d) => this.emitProgress('start', d.toString(), onProgress));
      child.on('error', (...a) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject((a[0] as unknown as Error) ?? new Error('spawn error'));
      });
      child.on('exit', (...a) => {
        const code = (a[0] as unknown as number | null) ?? null;
        this.process = null;
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error(`omniroute exited before readiness (code=${code})`));
      });

      pollTimer = setInterval(() => {
        void this.deps.healthProbe(OMNIROUTE_HEALTH_URL).then((ok) => {
          if (ok) ready();
        });
      }, HEALTH_POLL_MS);
      pollTimer.unref?.();

      fallbackTimer = setTimeout(() => {
        // Only accept the timeout fallback if the process is still alive AND a
        // final health probe passes - a Next.js server that is up but slow to
        // print a ready line should still register, but a wedged one must not.
        if (resolved || !this.process || this.process.killed) return;
        void this.deps.healthProbe(OMNIROUTE_HEALTH_URL).then((ok) => {
          if (ok) ready();
          else if (!resolved) {
            resolved = true;
            cleanup();
            reject(new Error('omniroute did not become healthy in time'));
          }
        });
      }, this.deps.readyTimeoutMs);
      fallbackTimer.unref?.();
    });
  }

  private async killProcess(): Promise<void> {
    const child = this.process;
    if (!child) return;
    child.kill('SIGTERM');
    const forceKill = setTimeout(() => {
      if (this.process && !this.process.killed) this.process.kill('SIGKILL');
    }, FORCE_KILL_MS);
    forceKill.unref?.();
    await new Promise<void>((resolve) => {
      child.once('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });
    });
    this.process = null;
  }

  private spawnOpts(env: Record<string, string>): OmnirouteSpawnOptions {
    return { stdio: ['ignore', 'pipe', 'pipe'], env, ...this.deps.spawnShellOptions() };
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
