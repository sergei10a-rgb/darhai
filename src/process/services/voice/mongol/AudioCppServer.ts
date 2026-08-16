/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lifecycle manager for the audio.cpp STT server (docs/architecture/
 * mongolian-voice.md): the Darhai-owned local process that serves the
 * Nemotron Монгол v13mn ASR model over an OpenAI-compatible loopback HTTP
 * endpoint, CPU-only (measured 12.4x faster than real time on the reference
 * machine, so no GPU is ever requested).
 *
 * Mirrors LocalServeManager's spawn + readiness + kill-tree template
 * (`services/cookbook/LocalServeManager.ts`), reduced to this server's shape:
 * one process, one model, configuration passed as a JSON file
 * (`audiocpp_server.exe --config <json>`), and readiness decided purely by
 * HTTP polling - audio.cpp has no documented stdout ready line worth parsing.
 *
 * Ownership contract: Darhai starts the process on demand, restarts it on the
 * next request after a crash (the `exit` handler clears the slot), and stops
 * it on app quit - the before-quit path imports {@link stopAudioCppServer};
 * no app-lifecycle wiring lives in this module.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getPlatformServices } from '@/common/platform';
import { allocateEphemeralPort } from '@process/services/cookbook/LocalServeManager';
import { killProcessTree } from '@process/services/omnirouteGateway/killProcessTree';
import { STT_MODEL_ASSET, STT_RUNTIME_ASSET, STT_SERVER_RELPATH } from './manifest';
import {
  componentInstallDir,
  isSttModelInstalled,
  isVoiceComponentInstalled,
  mongolVoiceRoot,
  sttModelPath,
} from './installLayout';

/** Model id inside the server config; transcription requests name the same id. */
export const STT_SERVER_MODEL_ID = 'mn-asr';

/**
 * Loopback ONLY - never 0.0.0.0. The server is keyless, so binding all
 * interfaces would hand the ASR endpoint to the whole local network (the same
 * hole the LM Studio audit measured on llama-server's default CORS).
 */
const LOOPBACK_HOST = '127.0.0.1';

/** CPU worker-thread cap; the config takes `min(8, logical cores)`. */
const MAX_THREADS = 8;

/** Health poll cadence (ms). CPU model load measured ~1.1 s, so 100 ms polls resolve fast. */
const HEALTH_POLL_INTERVAL_MS = 100;

/** Readiness deadline (ms): generous headroom over the measured 1-2 s load. */
const HEALTH_TIMEOUT_MS = 30_000;

/** Budget for a single health GET (ms) so a hung listener cannot stall the poll loop. */
const HEALTH_FETCH_TIMEOUT_MS = 1500;

/** Trailing server output kept for failure diagnostics. */
const OUTPUT_TAIL_CHARS = 2048;

/** Config file written under `<mongolVoiceRoot>/stt/`; regenerated on every start. */
const SERVER_CONFIG_NAME = 'server-config.json';

/**
 * Readiness probes, tried in order per poll tick. audio.cpp release-0.6
 * documents no stable health route: llama.cpp-derived builds answer
 * `GET /health`, while the OpenAI-compatible surface always carries
 * `GET /v1/models`. Accepting the first 200 from either keeps readiness
 * working across server builds instead of betting on one route - answering
 * either proves the HTTP listener is bound and request routing works.
 */
const HEALTH_PATHS = ['/health', '/v1/models'] as const;

/**
 * The GGUF's on-disk filename. The manifest always sets `filename` for
 * `format: 'file'` assets; the fallback merely satisfies the optional type.
 */
const STT_MODEL_FILENAME = STT_MODEL_ASSET.filename ?? 'nemotron-mn-v13m-q8_0.gguf';

/** Why the local Nemotron STT server cannot serve right now. */
export type AudioCppUnavailableCode =
  | 'NEMOTRON_MN_NOT_INSTALLED'
  | 'NEMOTRON_MN_START_FAILED'
  | 'NEMOTRON_MN_START_TIMEOUT';

/**
 * Typed lifecycle failure. The message starts with the code so
 * SpeechToTextService's `getErrorCode` (split on ':') surfaces it, and the UI
 * keys its "install Mongolian voice" affordance on `NEMOTRON_MN_NOT_INSTALLED`.
 */
export class AudioCppUnavailableError extends Error {
  readonly code: AudioCppUnavailableCode;

  constructor(code: AudioCppUnavailableCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'AudioCppUnavailableError';
    this.code = code;
  }
}

/** Minimal child-process surface (test-substitutable; LocalServeManager's shape). */
export type AudioCppChildProcess = {
  stdout: { on: (event: 'data', cb: (data: Buffer | string) => void) => void } | null;
  stderr: { on: (event: 'data', cb: (data: Buffer | string) => void) => void } | null;
  on: (event: 'error' | 'exit', cb: (...args: never[]) => void) => void;
  kill: (signal?: NodeJS.Signals) => boolean;
  pid?: number;
};

/** Injectable collaborators - production defaults are wired in the constructor. */
export type AudioCppServerDeps = {
  /** Spawn the server process (defaults to node:child_process spawn). */
  spawn: (
    cmd: string,
    args: string[],
    opts: { cwd: string; stdio: ['ignore', 'pipe', 'pipe']; windowsHide: boolean }
  ) => AudioCppChildProcess;
  /** GET a health-probe URL; only `ok` is consulted. A rejection reads as "not up yet". */
  fetch: (url: string) => Promise<{ ok: boolean }>;
  /** Electron userData directory that roots the voice install tree. */
  userDataDir: () => string;
  /** process.platform seam; picks the Windows tree-kill in {@link AudioCppServer.stop}. */
  platform: () => NodeJS.Platform;
  /** Logical CPU count; the config's `threads` is capped at {@link MAX_THREADS}. */
  cpuCount: () => number;
  /** Allocate a free loopback TCP port (net.createServer bind probe). */
  probePort: () => Promise<number>;
  /** Is the audio.cpp runtime install complete (receipt parses, files present)? */
  isRuntimeInstalled: (userDataDir: string) => boolean;
  /** Is the GGUF present at its full pinned size? */
  isModelInstalled: (userDataDir: string) => boolean;
  /** Force-kill a process tree (Windows: `taskkill /PID <pid> /T /F`). */
  killTree: (pid: number) => Promise<void>;
  /** Health poll cadence (ms). */
  healthPollIntervalMs: number;
  /** Readiness deadline (ms). */
  healthTimeoutMs: number;
};

/** Shape of the JSON handed to `audiocpp_server.exe --config`. */
type AudioCppModelConfig = {
  id: string;
  family: string;
  path: string;
  task: string;
  mode: string;
  lazy: boolean;
};

type AudioCppServerConfig = {
  host: string;
  port: number;
  backend: string;
  threads: number;
  lazy_load: boolean;
  models: AudioCppModelConfig[];
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Append captured server output to a failure detail when there is any. */
const withTail = (detail: string, tail: string): string =>
  tail.trim().length > 0 ? `${detail}; server output: ${tail.trim()}` : detail;

/** Bounded health GET: a hung listener must not stall the poll loop. */
async function defaultHealthFetch(url: string): Promise<{ ok: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_FETCH_TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, { signal: controller.signal });
    return { ok: res.ok };
  } finally {
    clearTimeout(timer);
  }
}

export class AudioCppServer {
  private child: AudioCppChildProcess | null = null;
  private baseUrl: string | null = null;
  private startPromise: Promise<string> | null = null;
  private readonly deps: AudioCppServerDeps;

  constructor(deps?: Partial<AudioCppServerDeps>) {
    this.deps = {
      spawn: (cmd, args, opts) => nodeSpawn(cmd, args, opts) as unknown as AudioCppChildProcess,
      fetch: defaultHealthFetch,
      userDataDir: () => getPlatformServices().paths.getDataDir(),
      platform: () => process.platform,
      cpuCount: () => os.cpus().length,
      probePort: allocateEphemeralPort,
      isRuntimeInstalled: (userDataDir) => isVoiceComponentInstalled(userDataDir, 'stt-runtime', STT_RUNTIME_ASSET.tag),
      isModelInstalled: (userDataDir) => isSttModelInstalled(userDataDir, STT_MODEL_FILENAME, STT_MODEL_ASSET.bytes),
      killTree: async (pid) => {
        await killProcessTree(pid, true);
      },
      healthPollIntervalMs: HEALTH_POLL_INTERVAL_MS,
      healthTimeoutMs: HEALTH_TIMEOUT_MS,
      ...deps,
    };
  }

  /** True while a spawned server process is alive (its `exit` clears this). */
  isRunning(): boolean {
    return this.child !== null;
  }

  /**
   * Resolve the server's base URL, starting the process when needed.
   *
   * Concurrent callers share one in-flight start (the dictation path can fire
   * several transcriptions in a burst); a settled start clears the slot so the
   * next call re-evaluates - including the "user just installed the assets"
   * case after a `NEMOTRON_MN_NOT_INSTALLED` rejection.
   */
  async ensureRunning(): Promise<string> {
    if (this.startPromise !== null) return this.startPromise;
    const mine = this.start();
    this.startPromise = mine;
    try {
      return await mine;
    } finally {
      if (this.startPromise === mine) this.startPromise = null;
    }
  }

  /** Stop the server process and clear all state. Safe to call when idle. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.baseUrl = null;
    if (child === null) return;
    const pid = child.pid;
    if (this.deps.platform() === 'win32' && typeof pid === 'number' && pid > 0) {
      // Windows never cascades signals, so killing only the direct child would
      // orphan any workers audio.cpp forks; `taskkill /PID <pid> /T /F` reaps
      // the whole tree (same discipline as LocalServeManager / killProcessTree).
      await this.deps.killTree(pid);
      return;
    }
    // POSIX (a source-built runtime): the server is spawned attached and forks
    // no helpers there, so a direct SIGKILL suffices.
    child.kill('SIGKILL');
  }

  private async start(): Promise<string> {
    // Fast path: a live process that still answers keeps its base URL.
    if (this.child !== null && this.baseUrl !== null) {
      const running = this.baseUrl;
      const healthy = await this.isHealthy(running);
      if (healthy === true) return running;
      // Alive but unresponsive (or a crash whose exit event has not fired
      // yet): replace it rather than handing out a dead URL.
      await this.stop();
    }

    const userDataDir = this.deps.userDataDir();
    if (this.deps.isRuntimeInstalled(userDataDir) === false) {
      throw new AudioCppUnavailableError('NEMOTRON_MN_NOT_INSTALLED', 'the audio.cpp STT runtime is not installed');
    }
    if (this.deps.isModelInstalled(userDataDir) === false) {
      throw new AudioCppUnavailableError(
        'NEMOTRON_MN_NOT_INSTALLED',
        'the Nemotron Монгол GGUF model is not installed'
      );
    }

    const port = await this.deps.probePort();
    const configPath = await this.writeServerConfig(userDataDir, port);
    const installDir = componentInstallDir(userDataDir, 'stt-runtime', STT_RUNTIME_ASSET.tag);
    const exePath = path.join(installDir, STT_SERVER_RELPATH);

    let failureDetail = 'audiocpp_server exited before becoming ready';
    let outputTail = '';
    const recordOutput = (data: Buffer | string): void => {
      outputTail = `${outputTail}${String(data)}`.slice(-OUTPUT_TAIL_CHARS);
    };

    const child = this.deps.spawn(exePath, ['--config', configPath], {
      cwd: installDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.baseUrl = null;

    child.stdout?.on('data', recordOutput);
    child.stderr?.on('data', recordOutput);
    child.on('error', (...a) => {
      const error = a[0] as unknown as Error;
      failureDetail = `audiocpp_server failed to start: ${error.message}`;
      if (this.child === child) {
        this.child = null;
        this.baseUrl = null;
      }
    });
    child.on('exit', (...a) => {
      const code = (a[0] as unknown as number | null) ?? null;
      failureDetail = `audiocpp_server exited before becoming ready (code=${String(code)})`;
      if (this.child === child) {
        // The process died on its own: clear the slot so the next
        // ensureRunning spawns a fresh server instead of a dead base URL.
        this.child = null;
        this.baseUrl = null;
      }
    });

    const baseUrl = `http://${LOOPBACK_HOST}:${port}`;
    const deadline = Date.now() + this.deps.healthTimeoutMs;
    for (;;) {
      if (this.child !== child) {
        // Spawn error or exit-before-ready cleared the slot from an event.
        throw new AudioCppUnavailableError('NEMOTRON_MN_START_FAILED', withTail(failureDetail, outputTail));
      }
      // oxlint-disable-next-line no-await-in-loop -- readiness polling is inherently serial
      const healthy = await this.isHealthy(baseUrl);
      if (healthy === true) {
        this.baseUrl = baseUrl;
        return baseUrl;
      }
      if (Date.now() >= deadline) break;
      // oxlint-disable-next-line no-await-in-loop -- fixed poll cadence, see above
      await sleep(this.deps.healthPollIntervalMs);
    }

    // Alive but never became healthy: reap it so a stuck process cannot leak.
    await this.stop();
    throw new AudioCppUnavailableError(
      'NEMOTRON_MN_START_TIMEOUT',
      withTail(
        `audiocpp_server did not answer ${HEALTH_PATHS.join(' or ')} within ${String(this.deps.healthTimeoutMs)} ms`,
        outputTail
      )
    );
  }

  /** One readiness probe over {@link HEALTH_PATHS}; rejections mean "not up yet". */
  private async isHealthy(baseUrl: string): Promise<boolean> {
    for (const probePath of HEALTH_PATHS) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- the fallback route is only tried after the first fails
        const res = await this.deps.fetch(`${baseUrl}${probePath}`);
        if (res.ok === true) return true;
      } catch {
        // Connection refused / timed out - fall through to the next route.
      }
    }
    return false;
  }

  /**
   * Write the `--config` JSON. Regenerated on every start because the port is
   * chosen fresh each time; the file lives inside the managed voice tree so a
   * user wiping `<userData>/voice/mongol/` removes it too.
   */
  private async writeServerConfig(userDataDir: string, port: number): Promise<string> {
    const config: AudioCppServerConfig = {
      host: LOOPBACK_HOST,
      port,
      // CPU is the shipped default (measured 12.4x real time); no `device`
      // field on purpose - that selector only exists for the CUDA backend.
      backend: 'cpu',
      threads: Math.min(MAX_THREADS, this.deps.cpuCount()),
      lazy_load: true,
      models: [
        {
          id: STT_SERVER_MODEL_ID,
          family: 'nemotron_asr',
          path: sttModelPath(userDataDir, STT_MODEL_FILENAME),
          task: 'asr',
          mode: 'streaming',
          // The one model this server exists for loads at startup, so the
          // first transcription does not pay the ~1.1 s load in-request.
          lazy: false,
        },
      ],
    };
    const configDir = path.join(mongolVoiceRoot(userDataDir), 'stt');
    const configPath = path.join(configDir, SERVER_CONFIG_NAME);
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    return configPath;
  }
}

/**
 * App-wide singleton: one audio.cpp server per Darhai process. Only the app
 * shutdown path needs anything beyond {@link AudioCppServer.ensureRunning} -
 * it imports {@link stopAudioCppServer}; the before-quit wiring itself lives
 * outside this module.
 */
export const audioCppServer = new AudioCppServer();

/** Stop the singleton's server process (app shutdown path). */
export function stopAudioCppServer(): Promise<void> {
  return audioCppServer.stop();
}
