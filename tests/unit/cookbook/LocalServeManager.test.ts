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
  type ChildProcessLike,
  type LocalServeDeps,
} from '@process/services/cookbook/LocalServeManager';

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
