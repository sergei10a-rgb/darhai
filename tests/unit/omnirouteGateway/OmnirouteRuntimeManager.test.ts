/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * C2 runtime manager: install/start/stop/status/openDashboard as a convenience,
 * never-throws, with a hard LIABILITY-BOUNDARY assertion - the manager NEVER
 * connects a provider or writes OmniRoute's relay config (only install / spawn /
 * health / openDashboard). Spawn, fetch, the URL opener and the process-tree
 * killer are all injected; no network, no filesystem, no Electron.
 *
 * The `stop`/ownership blocks are REGRESSION tests for the audit finding that
 * `stop()` returned `{state:'stopped'}` in 8ms while the OmniRoute server kept
 * answering on port 20128 - because only the direct child (on Windows:
 * `cmd.exe`) was signalled, and because "running" was never checked against who
 * actually owns the port.
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

/** A port that is quiet until `serving.value` is flipped on. */
type Port = { value: boolean };

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
  killTree: vi.fn(async () => ({ ok: true, detail: 'fake killTree' })),
  ...over,
});

/**
 * Start a manager whose port is quiet, then becomes healthy - i.e. the ordinary
 * "Darhai spawned it" path, which is the only way to reach `owned: true`.
 */
async function startOwned(
  child: FakeChild,
  port: Port,
  over: Partial<OmnirouteRuntimeDeps> = {}
): Promise<OmnirouteRuntimeManager> {
  const mgr = new OmnirouteRuntimeManager(
    makeDeps({ spawn: () => child, healthProbe: vi.fn(async () => port.value), ...over })
  );
  const started = mgr.start();
  await vi.advanceTimersByTimeAsync(10); // preflight probe: port is quiet -> spawn
  port.value = true;
  await vi.advanceTimersByTimeAsync(900); // readiness poll -> healthy
  const status = await started;
  expect(status.state).toBe('running');
  expect(status.owned).toBe(true);
  return mgr;
}

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
    const port: Port = { value: false };
    vi.useFakeTimers();
    const mgr = new OmnirouteRuntimeManager(
      makeDeps({
        spawn: spawn as unknown as OmnirouteRuntimeDeps['spawn'],
        healthProbe: vi.fn(async () => port.value),
      })
    );
    const p = mgr.start();
    await vi.advanceTimersByTimeAsync(10);
    port.value = true;
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

  // REGRESSION: `runtimeKind` used to be assigned only inside install(), so the
  // common "already installed" start reported runtime:null while claiming to be
  // running, and the Settings card rendered a blank runtime.
  it('reports the runtime START actually used, with no install() call first (bun)', async () => {
    const port: Port = { value: false };
    vi.useFakeTimers();
    const mgr = await startOwned(new FakeChild(), port);
    expect(mgr.getStatus().runtime).toBe('bun');
  });

  it('reports the runtime START actually used, with no install() call first (node/PATH)', async () => {
    const port: Port = { value: false };
    vi.useFakeTimers();
    const mgr = await startOwned(new FakeChild(), port, {
      omnirouteBinCandidates: () => [],
      resolveCommandPath: (c) => (c === 'omniroute' ? '/usr/local/bin/omniroute' : null),
    });
    expect(mgr.getStatus().runtime).toBe('node');
  });
});

describe('OmnirouteRuntimeManager ownership', () => {
  // REGRESSION: a leftover/foreign server answering port 20128 made start()
  // report "running" without spawning anything, and Darhai then behaved as if
  // it owned that process.
  it('adopts an already-serving port WITHOUT spawning and marks it not-owned', async () => {
    const spawn = vi.fn(() => new FakeChild());
    const mgr = new OmnirouteRuntimeManager(
      makeDeps({
        spawn: spawn as unknown as OmnirouteRuntimeDeps['spawn'],
        healthProbe: vi.fn(async () => true),
      })
    );
    const status = await mgr.start();
    expect(status.state).toBe('running');
    expect(status.owned).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(mgr.isRunning).toBe(false); // no child of ours to control
  });

  it('marks a server Darhai spawned itself as owned', async () => {
    const port: Port = { value: false };
    vi.useFakeTimers();
    const mgr = await startOwned(new FakeChild(), port);
    expect(mgr.getStatus().owned).toBe(true);
  });
});

describe('OmnirouteRuntimeManager.stop', () => {
  // HEADLINE REGRESSION: killing the direct child leaves the grandchild holding
  // the port (on Windows the direct child is cmd.exe). stop() must reap the TREE.
  it('kills the whole spawned TREE, never the direct child alone', async () => {
    const child = new FakeChild();
    const port: Port = { value: false };
    const killTree = vi.fn(async (pid: number, force: boolean) => {
      child.emitExit(null, 'SIGTERM');
      port.value = false; // the tree died, so the port went quiet
      return { ok: true, detail: `killed ${pid} force=${String(force)}` };
    });
    vi.useFakeTimers();
    const mgr = await startOwned(child, port, { killTree });

    const stopping = mgr.stop();
    await vi.advanceTimersByTimeAsync(10);
    const status = await stopping;

    expect(killTree).toHaveBeenCalledWith(4242, false);
    expect(child.killSignals).toEqual([]); // the direct-child-only kill is gone
    expect(status.state).toBe('stopped');
    expect(status.port).toBeNull();
    expect(mgr.isRunning).toBe(false);
  });

  // Windows `taskkill` without /F refuses console processes on the spot; waiting
  // out a grace window there is dead time, so a refusal escalates immediately.
  it('escalates to a forced tree kill the moment the polite one is refused', async () => {
    const child = new FakeChild();
    const port: Port = { value: false };
    const killTree = vi.fn(async (pid: number, force: boolean) => {
      if (!force) return { ok: false, detail: 'This process can only be terminated forcefully' };
      child.emitExit(null, 'SIGKILL');
      port.value = false;
      return { ok: true, detail: `force-killed ${pid}` };
    });
    vi.useFakeTimers();
    const mgr = await startOwned(child, port, { killTree });

    const stopping = mgr.stop();
    await vi.advanceTimersByTimeAsync(10); // deliberately far below the grace window
    const status = await stopping;

    expect(killTree.mock.calls).toEqual([
      [4242, false],
      [4242, true],
    ]);
    expect(status.state).toBe('stopped');
  });

  // REGRESSION: stop() used to report 'stopped' purely because a signal had been
  // sent; the audit found the port still answering 4 seconds later.
  it("never reports 'stopped' while the port is still being served", async () => {
    const child = new FakeChild();
    const port: Port = { value: false };
    const killTree = vi.fn(async () => {
      child.emitExit(null, 'SIGKILL'); // our tree died...
      return { ok: true, detail: 'killed' };
    });
    vi.useFakeTimers();
    const mgr = await startOwned(child, port, { killTree });
    // ...but something Darhai does not own keeps answering on 20128.
    const stopping = mgr.stop();
    await vi.advanceTimersByTimeAsync(3000);
    const status = await stopping;

    expect(status.state).toBe('running');
    expect(status.owned).toBe(false);
    expect(status.error).toBe('stop-port-still-served');
  });

  it('reports an unowned listener honestly when there was never a child to kill', async () => {
    const mgr = new OmnirouteRuntimeManager(makeDeps({ healthProbe: vi.fn(async () => true) }));
    vi.useFakeTimers();
    const stopping = mgr.stop();
    await vi.advanceTimersByTimeAsync(3000);
    const status = await stopping;
    expect(status.state).toBe('running');
    expect(status.error).toBe('external-server');
  });

  it('stopAll (before-quit) reaps the tree through the same path', async () => {
    const child = new FakeChild();
    const port: Port = { value: false };
    const killTree = vi.fn(async () => {
      child.emitExit(null, 'SIGTERM');
      return { ok: true, detail: 'killed' };
    });
    vi.useFakeTimers();
    const mgr = await startOwned(child, port, { killTree });

    const quitting = mgr.stopAll();
    await vi.advanceTimersByTimeAsync(10);
    await quitting;

    expect(killTree).toHaveBeenCalledWith(4242, false);
    expect(mgr.isRunning).toBe(false);
  });

  // REGRESSION: Electron does not await async before-quit handlers (23ms
  // measured between before-quit and will-quit), so the awaited stopAll was cut
  // off and the server survived the app. The reaper must be synchronous.
  it('reapOnQuitSync hands the pid to a blocking killer and drops the handle', async () => {
    const child = new FakeChild();
    const port: Port = { value: false };
    const killTree = vi.fn(async () => ({ ok: true, detail: 'async kill' }));
    vi.useFakeTimers();
    const mgr = await startOwned(child, port, { killTree });

    const killedSync: number[] = [];
    mgr.reapOnQuitSync((pid) => killedSync.push(pid));

    expect(killedSync).toEqual([4242]);
    expect(mgr.isRunning).toBe(false);

    // The async cleanup that runs alongside it must not double-kill a dead pid.
    await mgr.stopAll();
    expect(killTree).not.toHaveBeenCalled();
  });

  it('reapOnQuitSync is a no-op when Darhai owns no process', () => {
    const mgr = new OmnirouteRuntimeManager(makeDeps());
    const killedSync: number[] = [];
    mgr.reapOnQuitSync((pid) => killedSync.push(pid));
    expect(killedSync).toEqual([]);
  });

  // REGRESSION: the readiness-timeout path set `this.process = null` WITHOUT
  // killing, so a slow-but-live server was orphaned with nothing left to stop it.
  it('reaps the tree when readiness times out instead of orphaning the server', async () => {
    const child = new FakeChild();
    const killTree = vi.fn(async () => {
      child.emitExit(null, 'SIGKILL');
      return { ok: true, detail: 'killed' };
    });
    vi.useFakeTimers();
    const mgr = new OmnirouteRuntimeManager(
      makeDeps({ spawn: () => child, healthProbe: vi.fn(async () => false), readyTimeoutMs: 1000, killTree })
    );
    const p = mgr.start();
    await vi.advanceTimersByTimeAsync(10); // preflight: quiet -> spawn
    await vi.advanceTimersByTimeAsync(1100); // readiness timeout fires
    const status = await p;

    expect(status.state).toBe('error');
    expect(status.error).toBe('omniroute did not become healthy in time');
    expect(killTree).toHaveBeenCalledWith(4242, false);
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
    const port: Port = { value: false };
    const healthProbe = vi.fn(async () => port.value);
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
    await vi.advanceTimersByTimeAsync(10);
    port.value = true;
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
