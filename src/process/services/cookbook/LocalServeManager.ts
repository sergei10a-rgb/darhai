/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local inference-server lifecycle manager for the cookbook-serve path.
 *
 * A direct port of {@link OpenClawGatewayManager}'s spawn + readiness + graceful
 * shutdown template, retargeted at whichever local inference server the host's
 * hardware supports, serving over a loopback OpenAI-compatible `/v1` endpoint.
 * The backend is chosen from the detected hardware (see backendPolicy.ts), never
 * assumed - {@link detectAvailability} reports which binaries are installed:
 *   - `vllm`         -> {@link startVllm} spawns `vllm serve <hf-repo>`, which
 *     self-downloads the model from the hub (no separate GGUF download).
 *   - `llama-server` -> {@link start} spawns it with a downloaded GGUF + a free
 *     port; GPU layers scale to the detected VRAM (0 = pure CPU).
 *   - `ollama`       -> {@link pullOllama} (`ollama pull`); the served model
 *     flows through the EXISTING keyless ollama-local provider (no spawn here).
 *   - none installed -> the caller falls back to the copy-command path built by
 *     {@link buildServeCommand}.
 *
 * One active serve at a time is an MVP DEFAULT design choice (not a hardware
 * limit): {@link start}/{@link startVllm} stop any existing process before
 * spawning. Readiness resolves on the FIRST of a stdout ready-signal, a
 * successful `/health` poll, or a timeout fallback while the process is still
 * alive. Shutdown is SIGTERM -> 5s -> SIGKILL, so a spawned vLLM/llama-server is
 * always reaped (incl. the app before-quit path).
 *
 * GPU offload is delegated to llama.cpp, not guessed here - see
 * {@link resolveGpuLayersArg} and {@link ngpuLayersForVram}.
 *
 * // secondary: concurrent serves on higher-VRAM machines and crash-watchdog
 * auto-restart are deferred.
 */

import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { getEnhancedEnv } from '@process/utils/shellEnv';
import type { CookbookBackend } from '@/common/types/cookbook';
import type { BackendAvailability } from './backendPolicy';

/** Minimal child-process surface the manager relies on (test-substitutable). */
export type ChildProcessLike = {
  stdout: { on: (event: 'data', cb: (data: Buffer | string) => void) => void } | null;
  stderr: { on: (event: 'data', cb: (data: Buffer | string) => void) => void } | null;
  on: (event: 'error' | 'exit', cb: (...args: never[]) => void) => void;
  once: (event: 'exit', cb: () => void) => void;
  kill: (signal?: NodeJS.Signals) => boolean;
  killed: boolean;
  pid?: number;
};

/** Injectable collaborators - production defaults are wired in the constructor. */
export type LocalServeDeps = {
  /** Spawn a child process (defaults to node:child_process spawn). */
  spawn: (
    cmd: string,
    args: string[],
    opts: { stdio: ['ignore', 'pipe', 'pipe']; env: Record<string, string> }
  ) => ChildProcessLike;
  /** Allocate a free loopback TCP port. */
  allocatePort: () => Promise<number>;
  /** Probe the server's `/health` endpoint; true once it answers 2xx. */
  healthProbe: (port: number) => Promise<boolean>;
  /** Resolve an executable on PATH (or verify an absolute path). */
  resolveCommandPath: (cmd: string) => string | null;
  /**
   * Extra absolute candidate paths for a Darhai-managed `llama-server`.
   *
   * Defaults to `() => []` - "nothing managed", which is what a bare manager
   * (and every test that constructs one) should see. Production injects
   * `llamaServerCandidates(userData)` from `@process/services/llamacpp` in
   * cookbookServeSingleton.ts; that is the seam that lets Darhai find the copy
   * it downloaded itself, so a machine with no hand-installed llama.cpp still
   * reports `llamaServer: true` from {@link detectAvailability}.
   */
  llamaServerCandidates: () => string[];
  /** Enhanced child-process environment. */
  env: () => Record<string, string>;
  /** Readiness timeout fallback (ms). */
  readyTimeoutMs: number;
  /**
   * Read a backend binary's `--help` text so {@link parseServerCapabilities}
   * can decide which flags it accepts. Measured on the reference machine
   * (llama.cpp b10441, `llama-server.exe --help`): 261 ms, 57 KB on stdout,
   * exit 0. The result is cached per binary path, so this runs at most once
   * per resolved binary per app session. Returns '' when the probe fails,
   * which reads as "no optional flags" - the conservative answer.
   */
  probeHelpText: (binary: string) => string;
};

/** Options for a llama-server start. */
export type LocalServeOptions = { ggufPath: string; ngl: number };

/** Options for a vLLM start: the Hugging Face repo vLLM self-downloads + serves. */
export type LocalServeVllmOptions = { hfRepo: string };

type ServeEvents = {
  ready: (port: number) => void;
  error: (error: Error) => void;
  exit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  stdout: (data: string) => void;
  stderr: (data: string) => void;
};

/** Conservative offloaded transformer layers per GB of VRAM (legacy fallback). */
const GPU_LAYERS_PER_GB = 3;
/**
 * llama.cpp's own offload planner: it reads FREE VRAM from the driver and
 * offloads as many layers as actually fit. Accepted by `-ngl` since the build
 * that documents "either an exact number, 'auto', or 'all'".
 */
const GPU_LAYERS_AUTO = 'auto';
/** Interval between `/health` polls while waiting for readiness (ms). */
const HEALTH_POLL_MS = 700;
/** Default suggested port for the degraded copy-command path. */
const SUGGESTED_SERVE_PORT = 8080;
/** SIGTERM -> SIGKILL escalation window (ms). */
const FORCE_KILL_MS = 5000;
/** Default readiness timeout fallback (ms). */
const DEFAULT_READY_TIMEOUT_MS = 20000;
/**
 * `--cors-origins` value for the spawned llama-server.
 *
 * llama-server's default is `*` WITH credentials enabled, and it logs its own
 * warning about that. Binding loopback does not contain it: a browser is a
 * local process, so any web page the user happens to visit can script a
 * cross-origin call to the served model and READ the answer. MEASURED against
 * b10441 on the reference machine with an `Origin: https://evil.example`
 * preflight to `/v1/chat/completions`:
 *   default            -> `Access-Control-Allow-Origin: https://evil.example`
 *                         plus `Access-Control-Allow-Credentials: true`
 *   `localhost`        -> no `Access-Control-Allow-Origin` header at all
 * while `http://localhost:*` / `http://127.0.0.1:*` origins are still echoed
 * (llama.cpp's own web UI keeps working) and an Origin-less request - which is
 * how Darhai's main process calls it - still answers 200. No API key is set
 * because the served endpoint is registered keyless (`cookbook-local`); this
 * closes the drive-by-website read without touching that contract.
 */
const CORS_ORIGINS_LOOPBACK_ONLY = 'localhost';

/**
 * Substrings in server stdout/stderr that signal the HTTP endpoint is up.
 * Covers both llama.cpp (`llama-server`) and vLLM's Uvicorn startup lines.
 */
const READY_SIGNALS = [
  'server is listening',
  'http server listening',
  'listening on',
  'all slots are idle',
  'model loaded',
  // vLLM (Uvicorn) startup signals.
  'uvicorn running',
  'application startup complete',
  'started server process',
];

function isReadySignal(output: string): boolean {
  const lower = output.toLowerCase();
  return READY_SIGNALS.some((s) => lower.includes(s));
}

/**
 * LEGACY fallback `--n-gpu-layers` from detected VRAM, for llama-server builds
 * that do not accept `-ngl auto` (see {@link parseServerCapabilities}). Kept
 * VRAM-proportional and unchanged, because there is no way to measure an older
 * binary's behaviour from here; a build that DOES support `auto` never sees
 * this number.
 *
 * A non-zero return also carries a second meaning consumed by
 * {@link LocalServeManager.resolveGpuLayersArg}: "this host has a usable GPU
 * budget". Zero still means pure-CPU serve, which must stay explicit so a user
 * who picked a CPU-only rig is not silently given the GPU.
 *
 * This formula is deliberately NOT the shipped offload decision. Measured on
 * the reference machine (RTX 4070 Laptop 8 GB, llama.cpp b10441, real
 * llama-server + `/completion`, warm page cache, MEDIAN of three runs - a
 * model's first run is disk-bound and flatters nothing):
 *   Qwen2.5-0.5B-Instruct  `-ngl 24` 227.5 -> `-ngl auto` 299.4  (1.32x)
 *   Qwen2.5-7B-Instruct    `-ngl 24`  29.1 -> `-ngl auto`  34.0  (1.17x)
 *   openai/gpt-oss-20b     `-ngl 24`   7.4 -> `-ngl auto`   9.6  (unstable)
 * The 20B is 12.8 GiB on an 8 GiB card, so it is dominated by host paging and
 * ranged 3.1-8.0 and 8.5-20.1 tok/s respectively; only the direction is solid.
 * VRAM was 6.6 GiB for the 7B at `-ngl 24` versus 7.4 GiB at `auto`, i.e. the
 * guessed count was slower while leaving usable VRAM unused - and for the 20B
 * it was slower at MORE VRAM (7.8 GiB versus 7.0 GiB), because a fixed count
 * that does not fit makes the driver page.
 */
export function ngpuLayersForVram(vramGb: number): number {
  if (!Number.isFinite(vramGb) || vramGb <= 0) return 0;
  return Math.min(999, Math.max(1, Math.floor(vramGb * GPU_LAYERS_PER_GB)));
}

/** Optional llama-server flags this manager uses only when the build has them. */
export type ServerCapabilities = {
  /** `-ngl auto` - llama.cpp sizes the offload from free VRAM itself. */
  autoGpuLayers: boolean;
  /** `--cors-origins` - restricts which web origins may read this server. */
  corsOrigins: boolean;
};

/** No optional flags: what an unreadable or ancient binary is assumed to be. */
const NO_CAPABILITIES: ServerCapabilities = { autoGpuLayers: false, corsOrigins: false };

/**
 * Extract one option's own help entry: the line `flag` occurs on, plus the
 * indented continuation lines under it. A new option starts at column 0, which
 * is where the entry ends. Structural, so no "how many characters" guess is
 * needed - on b10441 the `--n-gpu-layers` entry is 228 chars over three lines
 * and the next option (`-sm, --split-mode`) begins immediately after.
 */
function helpEntryFor(helpText: string, flag: string): string {
  const at = helpText.indexOf(flag);
  if (at < 0) return '';
  const lines = helpText.slice(at).split('\n');
  const entry: string[] = [];
  for (const line of lines) {
    if (entry.length > 0 && !/^\s/.test(line)) break;
    entry.push(line);
  }
  return entry.join('\n');
}

/**
 * Parse a llama-server `--help` dump into the optional flags it accepts. Pure,
 * so the flag decision is unit-testable without a binary.
 *
 * `autoGpuLayers` requires 'auto' to appear inside the `--n-gpu-layers` entry
 * itself, not anywhere in the 57 KB dump - "auto" occurs in unrelated options
 * (`--flash-attn auto`, `--spec-draft-ngl auto`), so a whole-text search would
 * report the capability on builds that lack it.
 */
export function parseServerCapabilities(helpText: string): ServerCapabilities {
  if (typeof helpText !== 'string' || helpText.length === 0) return { ...NO_CAPABILITIES };
  return {
    autoGpuLayers: helpEntryFor(helpText, '--n-gpu-layers').includes(`'${GPU_LAYERS_AUTO}'`),
    corsOrigins: helpText.includes('--cors-origins'),
  };
}

/** Default `--help` probe: stdout only, short timeout, never throws. */
export function defaultProbeHelpText(binary: string): string {
  try {
    return execFileSync(binary, ['--help'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

/** Build the exact hand-run serve command for the degraded copy path. */
export function buildServeCommand(ggufPath: string, ngl: number, port = SUGGESTED_SERVE_PORT): string {
  return `llama-server -m "${ggufPath}" --host 127.0.0.1 --port ${port} --n-gpu-layers ${ngl}`;
}

/** Allocate a free ephemeral loopback port via a throwaway listen(0). */
export function allocateEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('failed to allocate a free port'))));
    });
  });
}

/** Resolve an executable on PATH, or verify an absolute/relative path exists. */
export function resolveOnPath(cmd: string, envPath = process.env.PATH || ''): string | null {
  if (cmd.includes('/') || cmd.includes('\\')) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of envPath.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

/** Default `/health` probe using globalThis.fetch with a short timeout. */
async function defaultHealthProbe(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const OLLAMA_BINARIES = ['ollama', 'ollama.exe'] as const;
const LLAMA_SERVER_BINARIES = ['llama-server', 'llama-server.exe'] as const;
const VLLM_BINARIES = ['vllm', 'vllm.exe'] as const;

export class LocalServeManager extends EventEmitter {
  private process: ChildProcessLike | null = null;
  private portValue: number | null = null;
  private startPromise: Promise<number> | null = null;
  private overrideBinary: string | null = null;
  private readonly deps: LocalServeDeps;
  /** `--help`-derived flag support, memoised per resolved binary path. */
  private readonly capabilities = new Map<string, ServerCapabilities>();

  constructor(deps?: Partial<LocalServeDeps>) {
    super();
    this.deps = {
      spawn: (cmd, args, opts) =>
        nodeSpawn(cmd, args, { stdio: opts.stdio, env: opts.env }) as unknown as ChildProcessLike,
      allocatePort: allocateEphemeralPort,
      healthProbe: defaultHealthProbe,
      resolveCommandPath: (cmd) => resolveOnPath(cmd),
      llamaServerCandidates: () => [],
      env: () => getEnhancedEnv() as Record<string, string>,
      readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
      probeHelpText: defaultProbeHelpText,
      ...deps,
    };
  }

  /** Flags the given binary accepts; probed once per path, then cached. */
  private capabilitiesFor(binary: string): ServerCapabilities {
    const cached = this.capabilities.get(binary);
    if (cached) return cached;
    let probed: ServerCapabilities;
    try {
      probed = parseServerCapabilities(this.deps.probeHelpText(binary));
    } catch {
      probed = { ...NO_CAPABILITIES };
    }
    this.capabilities.set(binary, probed);
    return probed;
  }

  /**
   * The `--n-gpu-layers` value to spawn with. `auto` whenever the build offers
   * it AND this host has a GPU budget, so llama.cpp measures free VRAM and
   * fits the layers itself instead of us guessing from total VRAM. `0` stays
   * literal (pure-CPU serve); older builds keep the caller's number.
   */
  private resolveGpuLayersArg(binary: string, ngl: number): string {
    if (!Number.isFinite(ngl) || ngl <= 0) return '0';
    return this.capabilitiesFor(binary).autoGpuLayers ? GPU_LAYERS_AUTO : String(ngl);
  }

  override emit<K extends keyof ServeEvents>(event: K, ...args: Parameters<ServeEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof ServeEvents>(event: K, listener: ServeEvents[K]): this {
    return super.on(event, listener);
  }

  /** Pin a user-located `llama-server` binary (degraded-path file picker). */
  setBackendBinary(binaryPath: string): boolean {
    const resolved = this.deps.resolveCommandPath(binaryPath);
    if (!resolved) return false;
    this.overrideBinary = resolved;
    return true;
  }

  /** Resolve a runnable `llama-server`: override, then PATH, then managed dir. */
  resolveLlamaServer(): string | null {
    if (this.overrideBinary) return this.overrideBinary;
    for (const name of LLAMA_SERVER_BINARIES) {
      const found = this.deps.resolveCommandPath(name);
      if (found) return found;
    }
    for (const candidate of this.deps.llamaServerCandidates()) {
      const found = this.deps.resolveCommandPath(candidate);
      if (found) return found;
    }
    return null;
  }

  /**
   * Resolve a runnable `vllm`. Binary on PATH only for the MVP.
   * // secondary: a `python -m vllm` module-form fallback for pip-only installs.
   */
  resolveVllm(): string | null {
    for (const name of VLLM_BINARIES) {
      const found = this.deps.resolveCommandPath(name);
      if (found) return found;
    }
    return null;
  }

  /** Report which local backend binaries are installed (hardware-agnostic). */
  async detectAvailability(): Promise<BackendAvailability> {
    const ollama = OLLAMA_BINARIES.some((n) => !!this.deps.resolveCommandPath(n));
    return {
      ollama,
      llamaServer: !!this.resolveLlamaServer(),
      vllm: !!this.resolveVllm(),
    };
  }

  /**
   * Detect a single available local backend binary (raw install probe, not
   * hardware-weighted): ollama, then llama-server, then vllm. The hardware-aware
   * choice among viable backends is made by {@link selectBackend}; this stays a
   * simple "what is installed" signal for the locate / degraded affordance.
   */
  async detectBackend(): Promise<CookbookBackend> {
    for (const name of OLLAMA_BINARIES) {
      if (this.deps.resolveCommandPath(name)) return 'ollama';
    }
    if (this.resolveLlamaServer()) return 'llama-server';
    if (this.resolveVllm()) return 'vllm';
    return 'none';
  }

  /** Pull a model into the local Ollama daemon (`ollama pull <ref>`). */
  async pullOllama(ref: string): Promise<void> {
    const ollamaPath = OLLAMA_BINARIES.map((n) => this.deps.resolveCommandPath(n)).find((p): p is string => !!p);
    if (!ollamaPath) throw new Error('ollama binary not found on PATH');
    const env = this.deps.env();
    await new Promise<void>((resolve, reject) => {
      const child = this.deps.spawn(ollamaPath, ['pull', ref], { stdio: ['ignore', 'pipe', 'pipe'], env });
      child.stdout?.on('data', (d) => this.emit('stdout', d.toString()));
      child.stderr?.on('data', (d) => this.emit('stderr', d.toString()));
      child.on('error', (...a) => reject(a[0] as unknown as Error));
      child.on('exit', (...a) => {
        const code = a[0] as unknown as number | null;
        if (code === 0) resolve();
        else reject(new Error(`ollama pull exited with code ${code}`));
      });
    });
  }

  /**
   * Start a llama-server for `ggufPath`. Single serve at a time: any running
   * process is stopped first. Returns the bound port once ready.
   */
  async start(opts: LocalServeOptions): Promise<number> {
    return this.serialized(() =>
      this.launch({
        label: 'llama-server',
        resolveBinary: () => this.resolveLlamaServer(),
        buildArgs: (port, binary) => {
          const args = [
            '-m',
            opts.ggufPath,
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--n-gpu-layers',
            this.resolveGpuLayersArg(binary, opts.ngl),
          ];
          if (this.capabilitiesFor(binary).corsOrigins) {
            args.push('--cors-origins', CORS_ORIGINS_LOOPBACK_ONLY);
          }
          return args;
        },
      })
    );
  }

  /**
   * Start a vLLM server for `hfRepo`. vLLM self-downloads the model from the hub
   * on first run, so no separate GGUF download is needed. Single serve at a time
   * (same machinery as {@link start}). Returns the bound port once ready.
   */
  async startVllm(opts: LocalServeVllmOptions): Promise<number> {
    return this.serialized(() =>
      this.launch({
        label: 'vllm',
        resolveBinary: () => this.resolveVllm(),
        buildArgs: (port) => ['serve', opts.hfRepo, '--host', '127.0.0.1', '--port', String(port)],
      })
    );
  }

  /** Guard so concurrent start calls share one in-flight launch. */
  private async serialized(run: () => Promise<number>): Promise<number> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = run();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async launch(spec: {
    label: string;
    resolveBinary: () => string | null;
    /** `binary` is the RESOLVED path, so args can depend on that build's flags. */
    buildArgs: (port: number, binary: string) => string[];
  }): Promise<number> {
    // Single-serve invariant: stop any existing process before spawning a new one.
    if (this.process && !this.process.killed) {
      await this.stop();
    }

    const binary = spec.resolveBinary();
    if (!binary) throw new Error(`${spec.label} binary not found`);

    const port = await this.deps.allocatePort();
    const args = spec.buildArgs(port, binary);
    const child = this.deps.spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.deps.env() });
    this.process = child;
    this.portValue = port;

    return new Promise<number>((resolve, reject) => {
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
        this.emit('ready', port);
        resolve(port);
      };

      child.stdout?.on('data', (data) => {
        const output = data.toString();
        this.emit('stdout', output);
        if (isReadySignal(output)) ready();
      });
      child.stderr?.on('data', (data) => {
        const output = data.toString();
        this.emit('stderr', output);
        if (isReadySignal(output)) ready();
      });
      child.on('error', (...a) => {
        const error = a[0] as unknown as Error;
        this.emit('error', error);
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(error);
        }
      });
      child.on('exit', (...a) => {
        const code = (a[0] as unknown as number | null) ?? null;
        const signal = (a[1] as unknown as NodeJS.Signals | null) ?? null;
        this.emit('exit', { code, signal });
        this.process = null;
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`${spec.label} exited before readiness (code=${code})`));
        }
      });

      pollTimer = setInterval(() => {
        void this.deps.healthProbe(port).then((ok) => {
          if (ok) ready();
        });
      }, HEALTH_POLL_MS);
      pollTimer.unref?.();

      fallbackTimer = setTimeout(() => {
        if (!resolved && this.process && !this.process.killed) ready();
      }, this.deps.readyTimeoutMs);
      fallbackTimer.unref?.();
    });
  }

  /** Stop the running server: SIGTERM, then SIGKILL after {@link FORCE_KILL_MS}. */
  async stop(): Promise<void> {
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
    this.portValue = null;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  get currentPort(): number | null {
    return this.portValue;
  }
}
