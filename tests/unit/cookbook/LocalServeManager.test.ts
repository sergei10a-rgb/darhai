/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// The real shellEnv pulls platform services; stub it so importing the manager
// stays out of Electron. Tests inject full deps anyway.
vi.mock('@process/utils/shellEnv', () => ({ getEnhancedEnv: () => ({}) }));

import {
  LocalServeManager,
  buildServeCommand,
  ngpuLayersForVram,
  parseServerCapabilities,
  type ChildProcessLike,
  type LocalServeDeps,
} from '@process/services/cookbook/LocalServeManager';

/**
 * Verbatim excerpts from `llama-server.exe --help` of the build Darhai ships
 * (llama.cpp b10441, measured on the reference machine). `--flash-attn` is
 * included on purpose: it is the decoy that makes a naive "does the help text
 * contain 'auto'" check report the wrong capability.
 */
const HELP_B10441 = [
  "-fa,   --flash-attn <on|off|auto>       set Flash Attention use ('on', 'off', or 'auto', default: 'auto')",
  '                                        (env: LLAMA_ARG_FLASH_ATTN)',
  '--cors-origins ORIGINS                  comma-separated list of allowed origins for CORS (default: *)',
  '                                        (env: LLAMA_ARG_CORS_ORIGINS)',
  '-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store in VRAM, either an exact number,',
  "                                        'auto', or 'all' (default: auto)",
  '                                        (env: LLAMA_ARG_N_GPU_LAYERS)',
].join('\n');

/** A pre-`auto`, pre-`--cors-origins` llama-server: an exact number only. */
const HELP_LEGACY = [
  "-fa,   --flash-attn <on|off|auto>       set Flash Attention use ('on', 'off', or 'auto')",
  '-ngl N, --n-gpu-layers N                number of layers to store in VRAM',
  '--api-key KEY                           API key to use for authentication',
].join('\n');

/** A controllable fake child process. */
class FakeChild implements ChildProcessLike {
  killed = false;
  pid = 4242;
  killSignals: string[] = [];
  private stdoutCbs: Array<(d: Buffer) => void> = [];
  private stderrCbs: Array<(d: Buffer) => void> = [];
  private exitCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];

  stdout = { on: (_e: 'data', cb: (d: Buffer | string) => void) => this.stdoutCbs.push(cb as (d: Buffer) => void) };
  stderr = { on: (_e: 'data', cb: (d: Buffer | string) => void) => this.stderrCbs.push(cb as (d: Buffer) => void) };

  on(event: 'error' | 'exit', cb: (...args: never[]) => void): void {
    if (event === 'exit') this.exitCbs.push(cb as never);
    else this.errorCbs.push(cb as never);
  }
  once(event: 'exit', cb: () => void): void {
    if (event === 'exit') this.exitCbs.push(() => cb());
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal || 'SIGTERM');
    return true;
  }
  emitStdout(s: string): void {
    this.stdoutCbs.forEach((cb) => cb(Buffer.from(s)));
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.killed = true;
    this.exitCbs.forEach((cb) => cb(code, signal));
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

const makeDeps = (over: Partial<LocalServeDeps> = {}): LocalServeDeps => ({
  spawn: () => new FakeChild(),
  allocatePort: vi.fn(async () => 51000),
  healthProbe: vi.fn(async () => false),
  resolveCommandPath: (cmd) => (cmd.includes('llama-server') ? '/usr/bin/llama-server' : null),
  llamaServerCandidates: () => [],
  env: () => ({}),
  readyTimeoutMs: 10000,
  probeHelpText: () => HELP_B10441,
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ngpuLayersForVram', () => {
  it('is 0 with no usable GPU budget', () => {
    expect(ngpuLayersForVram(0)).toBe(0);
    expect(ngpuLayersForVram(-4)).toBe(0);
  });
  it('scales conservatively with VRAM and caps', () => {
    expect(ngpuLayersForVram(8)).toBe(24);
    expect(ngpuLayersForVram(9999)).toBe(999);
  });
});

describe('parseServerCapabilities', () => {
  it('reads both optional flags off the shipped build help text', () => {
    expect(parseServerCapabilities(HELP_B10441)).toEqual({ autoGpuLayers: true, corsOrigins: true });
  });

  it('reports neither flag for a pre-auto llama-server', () => {
    expect(parseServerCapabilities(HELP_LEGACY)).toEqual({ autoGpuLayers: false, corsOrigins: false });
  });

  it("does not count an 'auto' that belongs to a different option", () => {
    // `--flash-attn ... 'auto'` sits BEFORE --n-gpu-layers in HELP_LEGACY, so a
    // whole-text search would claim -ngl auto on a build that rejects it.
    expect(HELP_LEGACY).toContain("'auto'");
    expect(parseServerCapabilities(HELP_LEGACY).autoGpuLayers).toBe(false);
  });

  it("stops at the next option, so a later entry's 'auto' does not leak in", () => {
    const next = [
      '-ngl N, --n-gpu-layers N                number of layers to store in VRAM',
      '                                        (env: LLAMA_ARG_N_GPU_LAYERS)',
      "--spec-draft-ngl N                      an exact number, or 'auto'",
    ].join('\n');
    expect(parseServerCapabilities(next).autoGpuLayers).toBe(false);
  });

  it('does read an indented continuation line of the --n-gpu-layers entry', () => {
    // b10441 puts 'auto' on the entry's SECOND line; a first-line-only check
    // would report the capability as missing on the build Darhai ships.
    expect(HELP_B10441.split('\n').find((l) => l.includes('--n-gpu-layers'))).not.toContain("'auto'");
    expect(parseServerCapabilities(HELP_B10441).autoGpuLayers).toBe(true);
  });

  it('treats an unreadable probe as "no optional flags"', () => {
    expect(parseServerCapabilities('')).toEqual({ autoGpuLayers: false, corsOrigins: false });
  });
});

describe('buildServeCommand', () => {
  it('builds the exact hand-run llama-server command', () => {
    expect(buildServeCommand('/c/m.gguf', 24)).toBe(
      'llama-server -m "/c/m.gguf" --host 127.0.0.1 --port 8080 --n-gpu-layers 24'
    );
  });
});

describe('LocalServeManager.detectBackend', () => {
  it('prefers ollama when present', async () => {
    const mgr = new LocalServeManager(
      makeDeps({ resolveCommandPath: (c) => (c.startsWith('ollama') ? '/usr/bin/ollama' : null) })
    );
    expect(await mgr.detectBackend()).toBe('ollama');
  });
  it('falls back to llama-server', async () => {
    const mgr = new LocalServeManager(makeDeps());
    expect(await mgr.detectBackend()).toBe('llama-server');
  });
  it('returns none when neither is installed', async () => {
    const mgr = new LocalServeManager(makeDeps({ resolveCommandPath: () => null, llamaServerCandidates: () => [] }));
    expect(await mgr.detectBackend()).toBe('none');
  });
  it('reports vllm when only vllm is installed', async () => {
    const mgr = new LocalServeManager(
      makeDeps({ resolveCommandPath: (c) => (c.startsWith('vllm') ? '/usr/bin/vllm' : null) })
    );
    expect(await mgr.detectBackend()).toBe('vllm');
  });
});

describe('LocalServeManager.detectAvailability', () => {
  it('reports each installed backend binary independently', async () => {
    const mgr = new LocalServeManager(
      makeDeps({
        resolveCommandPath: (c) => {
          if (c.startsWith('ollama')) return '/usr/bin/ollama';
          if (c.startsWith('vllm')) return '/usr/bin/vllm';
          if (c.includes('llama-server')) return '/usr/bin/llama-server';
          return null;
        },
      })
    );
    expect(await mgr.detectAvailability()).toEqual({ ollama: true, llamaServer: true, vllm: true });
  });
  it('is all-false when nothing is installed', async () => {
    const mgr = new LocalServeManager(makeDeps({ resolveCommandPath: () => null, llamaServerCandidates: () => [] }));
    expect(await mgr.detectAvailability()).toEqual({ ollama: false, llamaServer: false, vllm: false });
  });
});

describe('LocalServeManager.startVllm', () => {
  it('spawns `vllm serve <hf-repo>` bound to the allocated loopback port', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const deps = makeDeps({
      spawn: spawn as unknown as LocalServeDeps['spawn'],
      allocatePort: async () => 52001,
      resolveCommandPath: (c) => (c.startsWith('vllm') ? '/usr/bin/vllm' : null),
    });
    const mgr = new LocalServeManager(deps);
    const started = mgr.startVllm({ hfRepo: 'org/Model' });
    await tick();
    child.emitStdout('INFO: Uvicorn running on http://127.0.0.1:52001\n');
    await expect(started).resolves.toBe(52001);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [binary, args] = spawn.mock.calls[0];
    expect(binary).toBe('/usr/bin/vllm');
    expect(args).toEqual(['serve', 'org/Model', '--host', '127.0.0.1', '--port', '52001']);
  });

  it('rejects when no vllm binary is found', async () => {
    const mgr = new LocalServeManager(makeDeps({ resolveCommandPath: () => null }));
    await expect(mgr.startVllm({ hfRepo: 'org/Model' })).rejects.toThrow(/not found/);
  });
});

describe('LocalServeManager.start GPU offload + CORS arguments', () => {
  /** Spawn one llama-server and hand back the argv it was given. */
  const argvForStart = async (
    over: Partial<LocalServeDeps>,
    opts: { ggufPath: string; ngl: number }
  ): Promise<string[]> => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const mgr = new LocalServeManager(makeDeps({ spawn: spawn as unknown as LocalServeDeps['spawn'], ...over }));
    const started = mgr.start(opts);
    await tick();
    child.emitStdout('server is listening\n');
    await started;
    return spawn.mock.calls[0][1] as unknown as string[];
  };

  it('delegates the layer count to llama.cpp when the build accepts -ngl auto', async () => {
    // The shipped guess for an 8 GB card is 24. MEASURED on the reference
    // machine (RTX 4070 Laptop 8 GB, b10441, real llama-server /completion,
    // warm, median of three): Qwen2.5-0.5B 227.5 -> 299.4 tok/s and
    // Qwen2.5-7B 29.1 -> 34.0, the latter while USING more of the card
    // (6.6 -> 7.4 GiB) that the fixed count was leaving idle.
    const args = await argvForStart({}, { ggufPath: '/m.gguf', ngl: ngpuLayersForVram(8) });
    expect(args).toContain('--n-gpu-layers');
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('auto');
    expect(args).not.toContain('24');
  });

  it('keeps the numeric count for a llama-server build that has no auto', async () => {
    const args = await argvForStart({ probeHelpText: () => HELP_LEGACY }, { ggufPath: '/m.gguf', ngl: 24 });
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('24');
  });

  it('keeps a pure-CPU serve on the CPU even when auto is available', async () => {
    // ngl 0 means "this host has no GPU budget" (or the user picked a CPU-only
    // rig). `auto` would quietly start using a GPU that decision excluded.
    const args = await argvForStart({}, { ggufPath: '/m.gguf', ngl: 0 });
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('0');
  });

  it('restricts CORS to loopback origins when the build supports it', async () => {
    // MEASURED against b10441: with the default `*`, an `Origin:
    // https://evil.example` preflight to /v1/chat/completions came back with
    // `Access-Control-Allow-Origin: https://evil.example` and
    // `Access-Control-Allow-Credentials: true`; with `localhost` there was no
    // allow-origin header at all.
    const args = await argvForStart({}, { ggufPath: '/m.gguf', ngl: 24 });
    expect(args).toContain('--cors-origins');
    expect(args[args.indexOf('--cors-origins') + 1]).toBe('localhost');
  });

  it('omits --cors-origins on a build that would reject the flag', async () => {
    const args = await argvForStart({ probeHelpText: () => HELP_LEGACY }, { ggufPath: '/m.gguf', ngl: 24 });
    expect(args).not.toContain('--cors-origins');
  });

  it('probes a given binary --help at most once', async () => {
    const probeHelpText = vi.fn(() => HELP_B10441);
    const children = [new FakeChild(), new FakeChild()];
    let n = 0;
    const mgr = new LocalServeManager(
      makeDeps({
        probeHelpText,
        spawn: () => children[n++],
        allocatePort: vi.fn().mockResolvedValueOnce(51000).mockResolvedValueOnce(51001),
      })
    );

    const first = mgr.start({ ggufPath: '/a.gguf', ngl: 24 });
    await tick();
    children[0].emitStdout('server is listening\n');
    await first;

    const second = mgr.start({ ggufPath: '/b.gguf', ngl: 24 });
    await tick();
    children[0].emitExit(0, null);
    await tick();
    children[1].emitStdout('server is listening\n');
    await second;

    expect(probeHelpText).toHaveBeenCalledTimes(1);
  });

  it('falls back to the numeric count when the probe itself throws', async () => {
    const args = await argvForStart(
      {
        probeHelpText: () => {
          throw new Error('EACCES');
        },
      },
      { ggufPath: '/m.gguf', ngl: 24 }
    );
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('24');
    expect(args).not.toContain('--cors-origins');
  });
});

describe('LocalServeManager.start', () => {
  it('resolves on a stdout ready-signal and returns the allocated port', async () => {
    const child = new FakeChild();
    const deps = makeDeps({ spawn: () => child, allocatePort: async () => 51234 });
    const mgr = new LocalServeManager(deps);
    const started = mgr.start({ ggufPath: '/m.gguf', ngl: 20 });
    await tick();
    child.emitStdout('main: server is listening on 127.0.0.1:51234\n');
    await expect(started).resolves.toBe(51234);
    expect(mgr.isRunning).toBe(true);
    expect(mgr.currentPort).toBe(51234);
  });

  it('resolves via a successful /health poll even without a stdout signal', async () => {
    const child = new FakeChild();
    const deps = makeDeps({ spawn: () => child, healthProbe: vi.fn(async () => true) });
    const mgr = new LocalServeManager(deps);
    await expect(mgr.start({ ggufPath: '/m.gguf', ngl: 1 })).resolves.toBe(51000);
    expect(deps.healthProbe).toHaveBeenCalled();
  });

  it('resolves via the timeout fallback while the process is still alive', async () => {
    const child = new FakeChild();
    const deps = makeDeps({ spawn: () => child, readyTimeoutMs: 20 });
    const mgr = new LocalServeManager(deps);
    await expect(mgr.start({ ggufPath: '/m.gguf', ngl: 1 })).resolves.toBe(51000);
  });

  it('rejects when the process exits before readiness', async () => {
    const child = new FakeChild();
    const deps = makeDeps({ spawn: () => child, readyTimeoutMs: 10000 });
    const mgr = new LocalServeManager(deps);
    const started = mgr.start({ ggufPath: '/m.gguf', ngl: 1 });
    await tick();
    child.emitExit(1, null);
    await expect(started).rejects.toThrow(/exited before readiness/);
  });

  it('rejects when no llama-server binary is found', async () => {
    const mgr = new LocalServeManager(makeDeps({ resolveCommandPath: () => null, llamaServerCandidates: () => [] }));
    await expect(mgr.start({ ggufPath: '/m.gguf', ngl: 1 })).rejects.toThrow(/not found/);
  });

  it('single-serve: starting a second serve stops the first (SIGTERM)', async () => {
    const child1 = new FakeChild();
    const child2 = new FakeChild();
    let n = 0;
    const deps = makeDeps({
      spawn: () => (n++ === 0 ? child1 : child2),
      allocatePort: vi.fn().mockResolvedValueOnce(51000).mockResolvedValueOnce(51001),
    });
    const mgr = new LocalServeManager(deps);

    const first = mgr.start({ ggufPath: '/a.gguf', ngl: 1 });
    await tick();
    child1.emitStdout('server is listening\n');
    await first;

    const second = mgr.start({ ggufPath: '/b.gguf', ngl: 1 });
    await tick();
    expect(child1.killSignals).toContain('SIGTERM');
    child1.emitExit(0, null); // let the internal stop() resolve
    await tick();
    child2.emitStdout('server is listening\n');
    await expect(second).resolves.toBe(51001);
    expect(n).toBe(2);
  });
});

describe('LocalServeManager.stop', () => {
  it('escalates SIGTERM then SIGKILL after the grace window', async () => {
    const child = new FakeChild();
    const mgr = new LocalServeManager(makeDeps({ spawn: () => child }));
    const started = mgr.start({ ggufPath: '/m.gguf', ngl: 1 });
    await tick();
    child.emitStdout('server is listening\n');
    await started;

    vi.useFakeTimers();
    const stopping = mgr.stop();
    expect(child.killSignals).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(5000);
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    child.emitExit(null, 'SIGKILL');
    await stopping;
    expect(mgr.isRunning).toBe(false);
  });
});

describe('LocalServeManager.pullOllama', () => {
  it('resolves when ollama pull exits 0', async () => {
    const child = new FakeChild();
    const deps = makeDeps({
      spawn: () => child,
      resolveCommandPath: (c) => (c.startsWith('ollama') ? '/usr/bin/ollama' : null),
    });
    const mgr = new LocalServeManager(deps);
    const pulling = mgr.pullOllama('hf.co/org/Model-GGUF:Q4_K_M');
    await tick();
    child.emitExit(0, null);
    await expect(pulling).resolves.toBeUndefined();
  });

  it('rejects when ollama pull exits non-zero', async () => {
    const child = new FakeChild();
    const deps = makeDeps({
      spawn: () => child,
      resolveCommandPath: (c) => (c.startsWith('ollama') ? '/usr/bin/ollama' : null),
    });
    const mgr = new LocalServeManager(deps);
    const pulling = mgr.pullOllama('hf.co/org/Model-GGUF:Q4_K_M');
    await tick();
    child.emitExit(1, null);
    await expect(pulling).rejects.toThrow(/exited with code 1/);
  });

  it('rejects when ollama is not on PATH', async () => {
    const mgr = new LocalServeManager(makeDeps({ resolveCommandPath: () => null }));
    await expect(mgr.pullOllama('hf.co/x:Q4_K_M')).rejects.toThrow(/not found/);
  });
});
