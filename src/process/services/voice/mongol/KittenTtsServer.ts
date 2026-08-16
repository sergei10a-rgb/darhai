/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lifecycle manager for the kitten-mn Mongolian TTS bundle's local HTTP server
 * (docs/architecture/mongolian-voice.md).
 *
 * The bundle is embedded CPython + a FastAPI service; Darhai's only contract
 * with it is `bundle.json` at the bundle root (see `manifest.ts`). This module
 * owns the process: it spawns `<bundle>/<entry>` with `{port}` substituted into
 * the manifest args, polls `healthPath` until the service answers, and reaps
 * the whole process tree on stop. The server listens on 127.0.0.1 only
 * (verified in the kitten server source), so no key or firewall story applies.
 *
 * Measured context (Ryzen 9 7845HX, 2026-08-16): warm start ~2 s, synthesis at
 * RTF 0.18 on CPU - but a COLD first start (AV scan of a just-extracted tree,
 * ONNX session build) can take far longer, hence the 30 s readiness budget.
 *
 * Follows the spawn + readiness + kill template of
 * `services/cookbook/LocalServeManager.ts`, simplified: one fixed server, no
 * backend selection, readiness comes from health polling alone (stdio is not
 * piped - nothing drains it, and an undrained pipe would eventually block the
 * Python process on its own stdout).
 *
 * App-quit wiring (`before-quit` -> {@link KittenTtsServer.stop}) is done by
 * the index.ts integration, not here.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { getPlatformServices } from '@/common/platform';
import { allocateEphemeralPort } from '@process/services/cookbook/LocalServeManager';
import { killProcessTree } from '@process/services/omnirouteGateway/killProcessTree';
import {
  KITTEN_BUNDLE_MANIFEST_NAME,
  parseKittenBundleManifest,
  TTS_BUNDLE_ASSET,
  type KittenBundleManifest,
} from './manifest';
import {
  componentInstallDir,
  defaultVoiceFsProbe,
  isVoiceComponentInstalled,
  type VoiceFsProbe,
} from './installLayout';

/** Interval between health polls while waiting for readiness (ms). */
const HEALTH_POLL_INTERVAL_MS = 250;
/**
 * Readiness ceiling (ms). Warm start is ~2 s measured; the budget covers the
 * cold first start after install, when an AV scan holds the fresh tree open.
 */
const START_TIMEOUT_MS = 30_000;

export type KittenTtsErrorCode =
  | 'KITTEN_MN_NOT_INSTALLED'
  | 'KITTEN_MN_BUNDLE_INVALID'
  | 'KITTEN_MN_START_FAILED'
  | 'KITTEN_MN_START_TIMEOUT';

/**
 * Thrown when the kitten-mn server cannot be brought up. Carries a stable
 * `code` (also the message prefix) so the TTS bridge can surface a precise,
 * translatable user message instead of a stack trace.
 */
export class KittenTtsUnavailableError extends Error {
  readonly code: KittenTtsErrorCode;

  constructor(code: KittenTtsErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'KittenTtsUnavailableError';
    this.code = code;
  }
}

/** Minimal HTTP response surface the kitten client relies on (test-substitutable). */
export type KittenHttpResponse = {
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
  json: () => Promise<unknown>;
};

export type KittenFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

/** Loopback-only HTTP seam shared by the server (health) and KittenTts (speak). */
export type KittenFetch = (url: string, init?: KittenFetchInit) => Promise<KittenHttpResponse>;

/** Minimal child-process surface the manager relies on (test-substitutable). */
export type KittenChildLike = {
  pid?: number;
  killed: boolean;
  on: (event: 'error' | 'exit', cb: (...args: never[]) => void) => void;
  kill: (signal?: NodeJS.Signals) => boolean;
};

export type KittenSpawnOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  stdio: 'ignore';
};

/** Injectable collaborators - production defaults are wired in the constructor. */
export type KittenTtsServerDeps = {
  /** Spawn the bundle entry (defaults to node:child_process spawn). */
  spawn: (cmd: string, args: string[], opts: KittenSpawnOptions) => KittenChildLike;
  /** HTTP client for health polls (defaults to globalThis.fetch). */
  fetch: KittenFetch;
  /** Electron userData directory the voice tree lives under. */
  userDataDir: () => string;
  /** Allocate a free loopback TCP port to pass to the bundle. */
  probePort: () => Promise<number>;
  /** Filesystem seam shared with installLayout's readiness checks. */
  fsProbe: VoiceFsProbe;
  /**
   * Kill a pid AND every descendant. The direct child is `python.exe`, and on
   * Windows signals do not cascade - `taskkill /PID <pid> /T /F` (via
   * {@link killProcessTree}) is what actually clears the port.
   */
  killTree: (pid: number) => Promise<void>;
  /** Health poll interval (ms). */
  pollIntervalMs: number;
  /** Readiness ceiling (ms). */
  startTimeoutMs: number;
};

/** What a caller needs to talk to the running server. */
export type KittenTtsSession = {
  /** `http://127.0.0.1:<port>` - loopback only, no trailing slash. */
  baseUrl: string;
  /** The parsed bundle contract (healthPath / speakPath live here). */
  manifest: KittenBundleManifest;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const defaultDeps = (): KittenTtsServerDeps => ({
  spawn: (cmd, args, opts) =>
    nodeSpawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.stdio,
      windowsHide: true,
    }) as unknown as KittenChildLike,
  fetch: (url, init) => fetch(url, init),
  userDataDir: () => getPlatformServices().paths.getDataDir(),
  probePort: allocateEphemeralPort,
  fsProbe: defaultVoiceFsProbe,
  killTree: async (pid) => {
    await killProcessTree(pid, true);
  },
  pollIntervalMs: HEALTH_POLL_INTERVAL_MS,
  startTimeoutMs: START_TIMEOUT_MS,
});

/**
 * Single-instance manager for the kitten-mn TTS server process.
 *
 * `ensureRunning()` is idempotent: a healthy server is reused, a dead one is
 * restarted, and concurrent callers share one in-flight start. Use the
 * module-level {@link kittenTtsServer} in production; construct instances only
 * in tests.
 */
export class KittenTtsServer {
  private readonly deps: KittenTtsServerDeps;
  private child: KittenChildLike | null = null;
  private session: KittenTtsSession | null = null;
  private ready = false;
  private startPromise: Promise<KittenTtsSession> | null = null;

  constructor(deps?: Partial<KittenTtsServerDeps>) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  /**
   * Return a session against a healthy server, starting one if needed.
   *
   * Concurrent callers share ONE in-flight `start()` (AudioCppServer's
   * pattern): the shared promise is installed with no `await` between the
   * guard and the assignment, so a second caller can never slip past the
   * guard while the first is still probing health. Keeping the health check
   * inside the shared promise is what prevents two callers from both seeing
   * a hung session, both calling `startFresh()`, and leaking one of the two
   * spawned python.exe processes.
   */
  async ensureRunning(): Promise<KittenTtsSession> {
    if (this.startPromise !== null) return this.startPromise;
    const mine = this.start();
    this.startPromise = mine;
    try {
      return await mine;
    } finally {
      if (this.startPromise === mine) this.startPromise = null;
    }
  }

  /**
   * One shared start attempt. Order of checks mirrors what can actually be
   * wrong: an already-running healthy server short-circuits; otherwise the
   * install is verified (receipt-complete, see installLayout), `bundle.json`
   * is parsed, and only then is a process spawned and polled to readiness.
   */
  private async start(): Promise<KittenTtsSession> {
    const session = this.session;
    if (this.ready === true && this.child !== null && session !== null) {
      if ((await this.isHealthy(session)) === true) return session;
      // The process is up but not answering (or silently died): reap and restart.
      await this.stop();
    }
    return this.startFresh();
  }

  /** True while a spawned server has passed its readiness check and not exited. */
  isRunning(): boolean {
    return this.child !== null && this.ready === true;
  }

  /**
   * Kill the server's whole process tree and clear state. Safe to call when
   * nothing is running. The next `ensureRunning()` starts a fresh process.
   */
  async stop(): Promise<void> {
    const child = this.child;
    this.clearState();
    if (child === null) return;
    const pid = child.pid;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      await this.deps.killTree(pid);
    } else if (child.killed === false) {
      // No usable pid (spawn failed very early): best-effort direct kill.
      child.kill('SIGKILL');
    }
  }

  private clearState(): void {
    this.child = null;
    this.session = null;
    this.ready = false;
  }

  private async isHealthy(session: KittenTtsSession): Promise<boolean> {
    try {
      const res = await this.deps.fetch(`${session.baseUrl}${session.manifest.healthPath}`);
      return res.ok === true;
    } catch {
      return false;
    }
  }

  private async startFresh(): Promise<KittenTtsSession> {
    const userDataDir = this.deps.userDataDir();
    const { component, tag } = TTS_BUNDLE_ASSET;
    if (isVoiceComponentInstalled(userDataDir, component, tag, this.deps.fsProbe) === false) {
      throw new KittenTtsUnavailableError('KITTEN_MN_NOT_INSTALLED', `TTS bundle "${tag}" is not installed`);
    }

    const bundleDir = componentInstallDir(userDataDir, component, tag);
    const manifest = this.readBundleManifest(bundleDir);

    const port = await this.deps.probePort();
    const args = manifest.args.map((a) => a.replaceAll('{port}', String(port)));
    const entry = path.join(bundleDir, manifest.entry);

    const child = this.deps.spawn(entry, args, {
      cwd: bundleDir,
      // Windows Cyrillic pipe trap (project CLAUDE.md 6a): without these two,
      // embedded CPython picks cp1252 for stdio and dies with
      // UnicodeEncodeError on its first Cyrillic print.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: 'ignore',
    });

    const flags = { exited: false };
    const onGone = (): void => {
      flags.exited = true;
      if (this.child === child) this.clearState();
    };
    child.on('exit', onGone);
    child.on('error', onGone);

    const session: KittenTtsSession = { baseUrl: `http://127.0.0.1:${port}`, manifest };
    this.child = child;
    this.session = session;
    this.ready = false;

    try {
      await this.waitForHealth(session, flags);
    } catch (err) {
      // Reap the half-started process so a timeout never leaks a python.exe.
      await this.stop();
      throw err;
    }

    this.ready = true;
    return session;
  }

  private readBundleManifest(bundleDir: string): KittenBundleManifest {
    const manifestPath = path.join(bundleDir, KITTEN_BUNDLE_MANIFEST_NAME);
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.deps.fsProbe.readFileSync(manifestPath));
    } catch {
      throw new KittenTtsUnavailableError(
        'KITTEN_MN_BUNDLE_INVALID',
        `${KITTEN_BUNDLE_MANIFEST_NAME} is missing or not valid JSON`
      );
    }
    const manifest = parseKittenBundleManifest(parsed);
    if (manifest === null) {
      throw new KittenTtsUnavailableError(
        'KITTEN_MN_BUNDLE_INVALID',
        `${KITTEN_BUNDLE_MANIFEST_NAME} does not match the kitten-v1 contract`
      );
    }
    return manifest;
  }

  private async waitForHealth(session: KittenTtsSession, flags: { exited: boolean }): Promise<void> {
    const url = `${session.baseUrl}${session.manifest.healthPath}`;
    const deadline = Date.now() + this.deps.startTimeoutMs;
    for (;;) {
      if (flags.exited === true) {
        throw new KittenTtsUnavailableError(
          'KITTEN_MN_START_FAILED',
          'TTS server process exited before it became ready'
        );
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- polling is inherently serial
        const res = await this.deps.fetch(url);
        if (res.ok === true) return;
      } catch {
        // Not listening yet - a loopback connection refusal resolves in
        // milliseconds, so polling stays cheap while the service loads.
      }
      if (Date.now() >= deadline) {
        throw new KittenTtsUnavailableError(
          'KITTEN_MN_START_TIMEOUT',
          `TTS server did not answer ${session.manifest.healthPath} within ${this.deps.startTimeoutMs}ms`
        );
      }
      // oxlint-disable-next-line no-await-in-loop -- fixed poll cadence, see above
      await sleep(this.deps.pollIntervalMs);
    }
  }
}

/**
 * The one production instance. All dispatch goes through this; index.ts wires
 * its `stop()` into app shutdown (done by a separate integration change).
 */
export const kittenTtsServer = new KittenTtsServer();
