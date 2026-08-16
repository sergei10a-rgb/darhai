/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  KittenTtsServer,
  KittenTtsUnavailableError,
  type KittenChildLike,
  type KittenHttpResponse,
  type KittenSpawnOptions,
  type KittenTtsServerDeps,
} from '@process/services/voice/mongol/KittenTtsServer';
import { TTS_BUNDLE_ASSET } from '@process/services/voice/mongol/manifest';
import { componentInstallDir, voiceReceiptPath, type VoiceFsProbe } from '@process/services/voice/mongol/installLayout';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_DATA = path.join('fake', 'userData');
const TAG = TTS_BUNDLE_ASSET.tag;
const PORT = 45123;
const BUNDLE_DIR = componentInstallDir(USER_DATA, 'tts-bundle', TAG);

const receiptJson = JSON.stringify({
  schema: 1,
  component: 'tts-bundle',
  tag: TAG,
  platform: 'win32',
  arch: 'x64',
  asset: { url: 'https://example.invalid/kitten.zip', sha256: 'deadbeef', bytes: 1 },
  files: ['bundle.json', 'python/python.exe', 'service/server.py'],
  entryRelPath: 'python/python.exe',
  installedAt: '2026-08-16T00:00:00.000Z',
});

const bundleJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    name: 'kitten-mn-tts',
    version: 1,
    api: 'kitten-v1',
    entry: 'python/python.exe',
    args: ['service/server.py', '--onnx', '--port', '{port}'],
    healthPath: '/api/status',
    speakPath: '/api/speak',
    ...overrides,
  });

/** An installed bundle: complete receipt + every listed file + bundle.json content. */
const installedProbe = (bundleContent: string): VoiceFsProbe => {
  const files = new Map<string, string>();
  files.set(voiceReceiptPath(USER_DATA, 'tts-bundle', TAG), receiptJson);
  files.set(path.join(BUNDLE_DIR, 'bundle.json'), bundleContent);
  files.set(path.join(BUNDLE_DIR, 'python', 'python.exe'), '');
  files.set(path.join(BUNDLE_DIR, 'service', 'server.py'), '');
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
  };
};

const emptyProbe = (): VoiceFsProbe => ({
  existsSync: () => false,
  readFileSync: () => {
    throw new Error('ENOENT');
  },
});

const httpOk = (): KittenHttpResponse => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new ArrayBuffer(0),
  json: async () => ({ voices: ['default'] }),
});

type FakeChild = {
  child: KittenChildLike;
  exit: () => void;
};

const fakeChild = (pid = 4321): FakeChild => {
  const handlers = new Map<string, Array<() => void>>();
  const child: KittenChildLike = {
    pid,
    killed: false,
    on: (event, cb) => {
      const list = handlers.get(event) ?? [];
      list.push(cb as () => void);
      handlers.set(event, list);
    },
    kill: () => true,
  };
  return {
    child,
    exit: () => {
      for (const cb of handlers.get('exit') ?? []) cb();
    },
  };
};

type ServerSetup = {
  server: KittenTtsServer;
  spawn: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  killTree: ReturnType<typeof vi.fn>;
  children: FakeChild[];
};

const makeServer = (overrides: Partial<KittenTtsServerDeps> = {}): ServerSetup => {
  const children: FakeChild[] = [];
  const spawn = vi.fn((_cmd: string, _args: string[], _opts: KittenSpawnOptions): KittenChildLike => {
    const fc = fakeChild();
    children.push(fc);
    return fc.child;
  });
  const fetchMock = vi.fn(async (_url: string): Promise<KittenHttpResponse> => httpOk());
  const killTree = vi.fn(async (_pid: number): Promise<void> => {});
  const server = new KittenTtsServer({
    spawn,
    fetch: fetchMock,
    userDataDir: () => USER_DATA,
    probePort: async () => PORT,
    fsProbe: installedProbe(bundleJson()),
    killTree,
    pollIntervalMs: 1,
    startTimeoutMs: 250,
    ...overrides,
  });
  return { server, spawn, fetch: fetchMock, killTree, children };
};

const codeOf = (err: unknown): string => {
  expect(err).toBeInstanceOf(KittenTtsUnavailableError);
  return (err as KittenTtsUnavailableError).code;
};

// ---------------------------------------------------------------------------
// Install / manifest validation
// ---------------------------------------------------------------------------

describe('KittenTtsServer.ensureRunning - preconditions', () => {
  it('throws KITTEN_MN_NOT_INSTALLED without spawning when the bundle is absent', async () => {
    const { server, spawn } = makeServer({ fsProbe: emptyProbe() });
    const err = await server.ensureRunning().catch((e: unknown) => e);
    expect(codeOf(err)).toBe('KITTEN_MN_NOT_INSTALLED');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('throws KITTEN_MN_BUNDLE_INVALID without spawning when bundle.json is not valid JSON', async () => {
    const { server, spawn } = makeServer({ fsProbe: installedProbe('{ not json') });
    const err = await server.ensureRunning().catch((e: unknown) => e);
    expect(codeOf(err)).toBe('KITTEN_MN_BUNDLE_INVALID');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('throws KITTEN_MN_BUNDLE_INVALID without spawning when the contract does not parse', async () => {
    const { server, spawn } = makeServer({ fsProbe: installedProbe(bundleJson({ api: 'kitten-v999' })) });
    const err = await server.ensureRunning().catch((e: unknown) => e);
    expect(codeOf(err)).toBe('KITTEN_MN_BUNDLE_INVALID');
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Spawn shape
// ---------------------------------------------------------------------------

describe('KittenTtsServer.ensureRunning - spawn', () => {
  it('spawns the bundle entry with substituted port, bundle cwd, and UTF-8 python env', async () => {
    const { server, spawn } = makeServer();
    const session = await server.ensureRunning();

    expect(session.baseUrl).toBe(`http://127.0.0.1:${PORT}`);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0] as [string, string[], KittenSpawnOptions];
    expect(cmd).toBe(path.join(BUNDLE_DIR, 'python', 'python.exe'));
    expect(args).toEqual(['service/server.py', '--onnx', '--port', String(PORT)]);
    expect(opts.cwd).toBe(BUNDLE_DIR);
    // Windows Cyrillic pipe trap: both variables MUST reach the child, or the
    // embedded CPython picks cp1252 and dies on its first Cyrillic print.
    expect(opts.env.PYTHONIOENCODING).toBe('utf-8');
    expect(opts.env.PYTHONUTF8).toBe('1');
    expect(server.isRunning()).toBe(true);
  });

  it('replaces every {port} occurrence across all args', async () => {
    const probe = installedProbe(
      bundleJson({ args: ['service/server.py', '--port', '{port}', '--callback', 'http://127.0.0.1:{port}/done'] })
    );
    const { server, spawn } = makeServer({ fsProbe: probe });
    await server.ensureRunning();
    const [, args] = spawn.mock.calls[0] as [string, string[], KittenSpawnOptions];
    expect(args).toEqual(['service/server.py', '--port', String(PORT), '--callback', `http://127.0.0.1:${PORT}/done`]);
  });
});

// ---------------------------------------------------------------------------
// Health polling
// ---------------------------------------------------------------------------

describe('KittenTtsServer.ensureRunning - readiness', () => {
  it('keeps polling healthPath until the service answers 200', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string): Promise<KittenHttpResponse> => {
      calls += 1;
      if (calls <= 2) throw new Error('ECONNREFUSED');
      return httpOk();
    });
    const { server } = makeServer({ fetch: fetchMock });
    const session = await server.ensureRunning();
    expect(session.baseUrl).toBe(`http://127.0.0.1:${PORT}`);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(fetchMock.mock.calls[0][0]).toBe(`http://127.0.0.1:${PORT}/api/status`);
  });

  it('throws KITTEN_MN_START_TIMEOUT and reaps the process when health never answers', async () => {
    const fetchMock = vi.fn(async (_url: string): Promise<KittenHttpResponse> => {
      throw new Error('ECONNREFUSED');
    });
    const { server, killTree } = makeServer({ fetch: fetchMock, startTimeoutMs: 25 });
    const err = await server.ensureRunning().catch((e: unknown) => e);
    expect(codeOf(err)).toBe('KITTEN_MN_START_TIMEOUT');
    // The half-started python.exe must not leak.
    expect(killTree).toHaveBeenCalledWith(4321);
    expect(server.isRunning()).toBe(false);
  });

  it('throws KITTEN_MN_START_FAILED when the process exits before readiness', async () => {
    const setup = makeServer();
    setup.fetch.mockImplementation(async (): Promise<KittenHttpResponse> => {
      setup.children[0].exit();
      throw new Error('ECONNREFUSED');
    });
    const err = await setup.server.ensureRunning().catch((e: unknown) => e);
    expect(codeOf(err)).toBe('KITTEN_MN_START_FAILED');
    expect(setup.server.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reuse / restart / stop
// ---------------------------------------------------------------------------

describe('KittenTtsServer - lifecycle', () => {
  it('reuses a healthy server instead of spawning again', async () => {
    const { server, spawn } = makeServer();
    const first = await server.ensureRunning();
    const second = await server.ensureRunning();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(second.baseUrl).toBe(first.baseUrl);
  });

  it('stop() kills the process tree by pid and the next ensureRunning respawns', async () => {
    const { server, spawn, killTree } = makeServer();
    await server.ensureRunning();
    expect(server.isRunning()).toBe(true);

    await server.stop();
    expect(killTree).toHaveBeenCalledWith(4321);
    expect(server.isRunning()).toBe(false);

    await server.ensureRunning();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(server.isRunning()).toBe(true);
  });

  it('clears state when the server process exits, and restarts on the next call', async () => {
    const setup = makeServer();
    await setup.server.ensureRunning();
    expect(setup.server.isRunning()).toBe(true);

    // Simulate a crash of the running server.
    setup.children[0].exit();
    expect(setup.server.isRunning()).toBe(false);

    await setup.server.ensureRunning();
    expect(setup.spawn).toHaveBeenCalledTimes(2);
    expect(setup.server.isRunning()).toBe(true);
  });

  it('stop() is a no-op when nothing is running', async () => {
    const { server, killTree } = makeServer();
    await server.stop();
    expect(killTree).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Concurrent ensureRunning against a hung session
// ---------------------------------------------------------------------------

describe('KittenTtsServer - concurrent ensureRunning', () => {
  it('shares one restart and orphans no process when two calls hit a hung session', async () => {
    // Unique pid per spawn so orphan tracking can tell processes apart.
    let nextPid = 100;
    const children: FakeChild[] = [];
    const spawn = vi.fn((_cmd: string, _args: string[], _opts: KittenSpawnOptions): KittenChildLike => {
      const fc = fakeChild(nextPid);
      nextPid += 1;
      children.push(fc);
      return fc.child;
    });
    // While `hung` is set, the ORIGINAL server (spawn #1) never answers; any
    // server spawned after the hang (a restart) answers immediately.
    let hung = false;
    const fetchMock = vi.fn(async (_url: string): Promise<KittenHttpResponse> => {
      if (hung === true && spawn.mock.calls.length < 2) throw new Error('ECONNREFUSED');
      return httpOk();
    });
    const killTree = vi.fn(async (_pid: number): Promise<void> => {});
    const server = new KittenTtsServer({
      spawn,
      fetch: fetchMock,
      userDataDir: () => USER_DATA,
      probePort: async () => PORT,
      fsProbe: installedProbe(bundleJson()),
      killTree,
      pollIntervalMs: 1,
      startTimeoutMs: 250,
    });

    await server.ensureRunning(); // spawn #1 (pid 100), healthy
    expect(spawn).toHaveBeenCalledTimes(1);

    hung = true; // the running server stops answering, but its process lives on

    const [a, b] = await Promise.all([server.ensureRunning(), server.ensureRunning()]);
    expect(a.baseUrl).toBe(b.baseUrl);

    // ONE shared restart: exactly one new process on top of the original.
    // Without the shared-promise fix both callers pass the startPromise guard
    // (the health probe awaits before the guard is set), each spawns its own
    // python.exe, and the earlier one is orphaned when `this.child` is
    // overwritten - three spawns total and a leaked pid.
    expect(spawn).toHaveBeenCalledTimes(2);
    // The hung original was reaped, not orphaned.
    expect(killTree.mock.calls.map((c) => c[0] as number)).toContain(100);

    // After a final stop, every pid ever spawned must have been reaped.
    await server.stop();
    const reaped = [...new Set(killTree.mock.calls.map((c) => c[0] as number))].toSorted((x, y) => x - y);
    expect(reaped).toEqual([100, 101]);
  });
});
