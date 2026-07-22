/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * C2 runtime manager: install/start/stop/status/openDashboard as a convenience,
 * never-throws, with a hard LIABILITY-BOUNDARY assertion - the manager NEVER
 * connects a provider or writes OmniRoute's relay config (only install / spawn /
 * health / openDashboard). Spawn, fetch, and the URL opener are all injected;
 * no network, no filesystem, no Electron.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// The gateway service is the ONLY place a provider-connect could originate. Mock
// it so the liability test can prove the runtime manager never reaches it. (The
// manager does not even import it; a mock that is never called is the proof.)
const serviceMocks = vi.hoisted(() => ({
  applyOmnirouteGatewayConfig: vi.fn(async () => ({ ok: true })),
  testOmnirouteGatewayConnection: vi.fn(async () => ({ ok: true, modelCount: 0 })),
  getOmnirouteGatewayConfigView: vi.fn(async () => ({ enabled: false, baseUrl: '', hasApiKey: false })),
  fetchGatewayModels: vi.fn(async () => ({ ok: true, modelIds: [] })),
}));
vi.mock('@process/services/omnirouteGateway/omnirouteGatewayService', () => serviceMocks);

import {
  OMNIROUTE_DASHBOARD_URL,
  OMNIROUTE_PINNED_PACKAGE,
  OMNIROUTE_RUNTIME_PORT,
} from '@/common/types/omnirouteGateway';
import {
  OmnirouteRuntimeManager,
  type OmnirouteRuntimeDeps,
} from '@process/services/omnirouteGateway/OmnirouteRuntimeManager';
import type { ChildProcessLike } from '@process/services/cookbook/LocalServeManager';

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

const makeDeps = (over: Partial<OmnirouteRuntimeDeps> = {}): OmnirouteRuntimeDeps => ({
  spawn: () => new FakeChild(),
  healthProbe: vi.fn(async () => false),
  openUrl: vi.fn(async () => undefined),
  env: () => ({}),
  bundledBunPath: () => '/bundled/bun',
  resolveCommandPath: (c) => (c.includes('omniroute') ? '/home/.bun/bin/omniroute' : null),
  omnirouteBinCandidates: () => ['/home/.bun/bin/omniroute'],
  readyTimeoutMs: 10000,
  spawnShellOptions: () => ({}),
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('OmnirouteRuntimeManager.install', () => {
  it('installs via the bundled bun (add -g omniroute@pinned) and reports installed', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const mgr = new OmnirouteRuntimeManager(makeDeps({ spawn: spawn as unknown as OmnirouteRuntimeDeps['spawn'] }));
    const p = mgr.install();
    await tick();
    child.emitExit(0);
    const status = await p;
    expect(status.state).toBe('installed');
    expect(status.runtime).toBe('bun');
    const [exec, args] = spawn.mock.calls[0];
    expect(exec).toBe('/bundled/bun');
    expect(args).toEqual(['add', '-g', OMNIROUTE_PINNED_PACKAGE]);
  });

  it('falls back to system npm (install -g) when no bundled bun is present', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const mgr = new OmnirouteRuntimeManager(
      makeDeps({
        spawn: spawn as unknown as OmnirouteRuntimeDeps['spawn'],
        bundledBunPath: () => null,
        resolveCommandPath: (c) => (c === 'npm' ? '/usr/bin/npm' : null),
      })
    );
    const p = mgr.install();
    await tick();
    child.emitExit(0);
    const status = await p;
    expect(status.state).toBe('installed');
    expect(status.runtime).toBe('node');
    const [exec, args] = spawn.mock.calls[0];
    expect(exec).toBe('/usr/bin/npm');
    expect(args).toEqual(['install', '-g', OMNIROUTE_PINNED_PACKAGE]);
  });

  it('surfaces needsRuntime (never crashes) when no runtime is available', async () => {
    const spawn = vi.fn(() => new FakeChild());
    const mgr = new OmnirouteRuntimeManager(
      makeDeps({
        spawn: spawn as unknown as OmnirouteRuntimeDeps['spawn'],
        bundledBunPath: () => null,
        resolveCommandPath: () => null,
      })
    );
    const status = await mgr.install();
    expect(status.state).toBe('error');
    expect(status.needsRuntime).toBe(true);
    expect(status.error).toBe('no-runtime');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports error (never throws) when the install process exits non-zero', async () => {
    const child = new FakeChild();
    const mgr = new OmnirouteRuntimeManager(makeDeps({ spawn: () => child }));
    const p = mgr.install();
    await tick();
    child.emitExit(1);
    const status = await p;
    expect(status.state).toBe('error');
  });

  it('streams installer stdout as progress events', async () => {
    const child = new FakeChild();
    const onProgress = vi.fn();
    const mgr = new OmnirouteRuntimeManager(makeDeps({ spawn: () => child }));
    const p = mgr.install(onProgress);
    await tick();
    child.emitStdout('resolving dependencies...\n');
    child.emitExit(0);
    await p;
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'install', message: 'resolving dependencies...' })
    );
  });
});

describe('OmnirouteRuntimeManager.start', () => {
  it('spawns the omniroute bin on port 20128 and reports running once healthy', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    vi.useFakeTimers();
    const mgr = new OmnirouteRuntimeManager(
      makeDeps({ spawn: spawn as unknown as OmnirouteRuntimeDeps['spawn'], healthProbe: vi.fn(async () => true) })
    );
    const p = mgr.start();
    await vi.advanceTimersByTimeAsync(900);
    const status = await p;
    expect(status.state).toBe('running');
    expect(status.port).toBe(OMNIROUTE_RUNTIME_PORT);
    expect(status.dashboardUrl).toBe(OMNIROUTE_DASHBOARD_URL);
    const [exec, args, opts] = spawn.mock.calls[0];
    expect(exec).toBe('/home/.bun/bin/omniroute');
    expect(args).toEqual([]);
    expect(opts.env.PORT).toBe(String(OMNIROUTE_RUNTIME_PORT));
    expect(mgr.isRunning).toBe(true);
  });

  it('reports not-installed (never throws) when no omniroute bin is found', async () => {
    const mgr = new OmnirouteRuntimeManager(
      makeDeps({ resolveCommandPath: () => null, omnirouteBinCandidates: () => [] })
    );
    const status = await mgr.start();
    expect(status.state).toBe('error');
    expect(status.error).toBe('not-installed');
  });

  it('reports error (never throws) when the process exits before readiness', async () => {
    const child = new FakeChild();
    const mgr = new OmnirouteRuntimeManager(makeDeps({ spawn: () => child, healthProbe: vi.fn(async () => false) }));
    const p = mgr.start();
    await tick();
    child.emitExit(1);
    const status = await p;
    expect(status.state).toBe('error');
    expect(mgr.isRunning).toBe(false);
  });
});

describe('OmnirouteRuntimeManager.stop', () => {
  it('escalates SIGTERM then SIGKILL after the grace window', async () => {
    const child = new FakeChild();
    const mgr = new OmnirouteRuntimeManager(makeDeps({ spawn: () => child, healthProbe: vi.fn(async () => true) }));
    vi.useFakeTimers();
    const started = mgr.start();
    await vi.advanceTimersByTimeAsync(900);
    await started;

    const stopping = mgr.stop();
    expect(child.killSignals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    child.emitExit(null, 'SIGKILL');
    const status = await stopping;
    expect(status.state).toBe('stopped');
    expect(mgr.isRunning).toBe(false);
  });
});

describe('OmnirouteRuntimeManager.openDashboard', () => {
  it("opens OmniRoute's OWN dashboard URL", async () => {
    const openUrl = vi.fn(async () => undefined);
    const mgr = new OmnirouteRuntimeManager(makeDeps({ openUrl }));
    const result = await mgr.openDashboard();
    expect(result.ok).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(OMNIROUTE_DASHBOARD_URL);
  });

  it('never throws when the opener fails', async () => {
    const openUrl = vi.fn(async () => {
      throw new Error('no browser');
    });
    const mgr = new OmnirouteRuntimeManager(makeDeps({ openUrl }));
    const result = await mgr.openDashboard();
    expect(result.ok).toBe(false);
  });
});

describe('OmnirouteRuntimeManager - LIABILITY BOUNDARY', () => {
  it('never connects a provider or writes relay config across the full install→start→openDashboard flow', async () => {
    const installChild = new FakeChild();
    const startChild = new FakeChild();
    let n = 0;
    const spawn = vi.fn(() => (n++ === 0 ? installChild : startChild));
    const healthProbe = vi.fn(async () => true);
    const openUrl = vi.fn(async () => undefined);

    vi.useFakeTimers();
    const mgr = new OmnirouteRuntimeManager(
      makeDeps({ spawn: spawn as unknown as OmnirouteRuntimeDeps['spawn'], healthProbe, openUrl })
    );

    const installP = mgr.install();
    await vi.advanceTimersByTimeAsync(1);
    installChild.emitExit(0);
    expect((await installP).state).toBe('installed');

    const startP = mgr.start();
    await vi.advanceTimersByTimeAsync(900);
    expect((await startP).state).toBe('running');

    await mgr.openDashboard();

    // The ONLY side-effecting collaborators the manager may touch are spawn
    // (install + start), healthProbe, and openUrl. It must NEVER reach the
    // gateway service's provider-connect / relay-config / test-connection APIs.
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(healthProbe).toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith(OMNIROUTE_DASHBOARD_URL);
    expect(serviceMocks.applyOmnirouteGatewayConfig).not.toHaveBeenCalled();
    expect(serviceMocks.testOmnirouteGatewayConnection).not.toHaveBeenCalled();
    expect(serviceMocks.fetchGatewayModels).not.toHaveBeenCalled();
  });
});
