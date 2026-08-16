/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AudioCppServer lifecycle tests. Every OS boundary is a fake (spawn, fetch,
 * port probe, install checks, kill), so nothing here binds a socket or spawns
 * a process - only the config file is real, written into a per-test tmpdir so
 * the asserts read exactly what audiocpp_server.exe would read.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AudioCppServer,
  AudioCppUnavailableError,
  STT_SERVER_MODEL_ID,
} from '@process/services/voice/mongol/AudioCppServer';
import type { AudioCppChildProcess, AudioCppServerDeps } from '@process/services/voice/mongol/AudioCppServer';
import { componentInstallDir, mongolVoiceRoot, sttModelPath } from '@process/services/voice/mongol/installLayout';
import { STT_MODEL_ASSET, STT_RUNTIME_ASSET, STT_SERVER_RELPATH } from '@process/services/voice/mongol/manifest';

const FAKE_PID = 4242;
const FAKE_PORT = 8791;
const FAKE_BASE_URL = `http://127.0.0.1:${FAKE_PORT}`;

/** Controllable stand-in for the spawned audiocpp_server.exe. */
class FakeChild implements AudioCppChildProcess {
  pid = FAKE_PID;
  stdout = null;
  stderr = null;
  killed = false;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: 'error' | 'exit', cb: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb as unknown as (...args: unknown[]) => void);
    this.listeners.set(event, list);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emit(event: 'error' | 'exit', ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
}

const tempDirs: string[] = [];

const makeUserDataDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'darhai-audiocpp-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  vi.restoreAllMocks();
  const dirs = tempDirs.splice(0, tempDirs.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

type Harness = {
  server: AudioCppServer;
  child: FakeChild;
  spawn: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  killTree: ReturnType<typeof vi.fn>;
  userDataDir: string;
};

const makeHarness = async (overrides: Partial<AudioCppServerDeps> = {}): Promise<Harness> => {
  const userDataDir = await makeUserDataDir();
  const child = new FakeChild();
  const spawn = vi.fn(() => child);
  const fetch = vi.fn(async () => ({ ok: true }));
  const killTree = vi.fn(async () => {});
  const server = new AudioCppServer({
    spawn,
    fetch,
    userDataDir: () => userDataDir,
    platform: () => 'win32',
    cpuCount: () => 16,
    probePort: async () => FAKE_PORT,
    isRuntimeInstalled: () => true,
    isModelInstalled: () => true,
    killTree,
    healthPollIntervalMs: 1,
    healthTimeoutMs: 250,
    ...overrides,
  });
  return { server, child, spawn, fetch, killTree, userDataDir };
};

const readConfig = async (userDataDir: string): Promise<Record<string, unknown>> => {
  const configPath = path.join(mongolVoiceRoot(userDataDir), 'stt', 'server-config.json');
  return JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
};

describe('AudioCppServer', () => {
  it('writes a loopback-only CPU config and spawns the installed runtime', async () => {
    const h = await makeHarness();
    const baseUrl = await h.server.ensureRunning();

    expect(baseUrl).toBe(FAKE_BASE_URL);
    expect(h.server.isRunning()).toBe(true);

    const config = await readConfig(h.userDataDir);
    expect(config.host).toBe('127.0.0.1');
    // The LM Studio lesson, asserted on its own: a keyless local server bound
    // to 0.0.0.0 is reachable from the whole LAN.
    expect(config.host).not.toBe('0.0.0.0');
    expect(config.backend).toBe('cpu');
    // No CUDA device selector may leak into the CPU config.
    expect('device' in config).toBe(false);
    expect(config.threads).toBe(8); // min(8, 16 logical cores)
    expect(config.port).toBe(FAKE_PORT);

    const models = config.models as Array<Record<string, unknown>>;
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe(STT_SERVER_MODEL_ID);
    expect(models[0].family).toBe('nemotron_asr');
    expect(models[0].task).toBe('asr');
    expect(models[0].mode).toBe('streaming');
    expect(models[0].path).toBe(sttModelPath(h.userDataDir, STT_MODEL_ASSET.filename as string));

    const installDir = componentInstallDir(h.userDataDir, 'stt-runtime', STT_RUNTIME_ASSET.tag);
    const configPath = path.join(mongolVoiceRoot(h.userDataDir), 'stt', 'server-config.json');
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = h.spawn.mock.calls[0] as [string, string[], { cwd: string }];
    expect(cmd).toBe(path.join(installDir, STT_SERVER_RELPATH));
    expect(args).toEqual(['--config', configPath]);
    expect(opts.cwd).toBe(installDir);
  });

  it('caps threads at the machine core count when below 8', async () => {
    const h = await makeHarness({ cpuCount: () => 4 });
    await h.server.ensureRunning();
    const config = await readConfig(h.userDataDir);
    expect(config.threads).toBe(4);
  });

  it('refuses with NEMOTRON_MN_NOT_INSTALLED when the runtime is missing, without spawning', async () => {
    const h = await makeHarness({ isRuntimeInstalled: () => false });
    const failure = await h.server.ensureRunning().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AudioCppUnavailableError);
    expect((failure as AudioCppUnavailableError).code).toBe('NEMOTRON_MN_NOT_INSTALLED');
    expect((failure as Error).message).toMatch(/^NEMOTRON_MN_NOT_INSTALLED:/);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('refuses with NEMOTRON_MN_NOT_INSTALLED when the GGUF is missing, without spawning', async () => {
    const h = await makeHarness({ isModelInstalled: () => false });
    const failure = await h.server.ensureRunning().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AudioCppUnavailableError);
    expect((failure as AudioCppUnavailableError).code).toBe('NEMOTRON_MN_NOT_INSTALLED');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('keeps polling through early connection failures until the server answers', async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls <= 5) throw new Error('connect ECONNREFUSED');
      return { ok: true };
    });
    const h = await makeHarness({ fetch });
    const baseUrl = await h.server.ensureRunning();
    expect(baseUrl).toBe(FAKE_BASE_URL);
    expect(fetch.mock.calls.length).toBeGreaterThan(5);
  });

  it('accepts /v1/models when /health is not served (dual-endpoint readiness)', async () => {
    const fetch = vi.fn(async (url: string) => ({ ok: url.endsWith('/v1/models') }));
    const h = await makeHarness({ fetch });
    await expect(h.server.ensureRunning()).resolves.toBe(FAKE_BASE_URL);
    expect(fetch).toHaveBeenCalledWith(`${FAKE_BASE_URL}/health`);
    expect(fetch).toHaveBeenCalledWith(`${FAKE_BASE_URL}/v1/models`);
  });

  it('times out with a typed error and reaps the stuck process', async () => {
    const fetch = vi.fn(async () => ({ ok: false }));
    const h = await makeHarness({ fetch, healthTimeoutMs: 30 });
    const failure = await h.server.ensureRunning().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AudioCppUnavailableError);
    expect((failure as AudioCppUnavailableError).code).toBe('NEMOTRON_MN_START_TIMEOUT');
    expect(h.killTree).toHaveBeenCalledWith(FAKE_PID);
    expect(h.server.isRunning()).toBe(false);
  });

  it('fails with NEMOTRON_MN_START_FAILED when the process dies before readiness', async () => {
    const fetch = vi.fn(async () => ({ ok: false }));
    const h = await makeHarness({ fetch, healthTimeoutMs: 5000 });
    const pending = h.server.ensureRunning();
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalled());
    h.child.emit('exit', 1, null);
    const failure = await pending.catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AudioCppUnavailableError);
    expect((failure as AudioCppUnavailableError).code).toBe('NEMOTRON_MN_START_FAILED');
    expect(h.server.isRunning()).toBe(false);
  });

  it('clears state on crash and respawns on the next ensureRunning', async () => {
    const h = await makeHarness();
    await h.server.ensureRunning();
    expect(h.server.isRunning()).toBe(true);

    h.child.emit('exit', 1, null);
    expect(h.server.isRunning()).toBe(false);

    const baseUrl = await h.server.ensureRunning();
    expect(baseUrl).toBe(FAKE_BASE_URL);
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });

  it('reuses a healthy running server instead of spawning another', async () => {
    const h = await makeHarness();
    const first = await h.server.ensureRunning();
    const second = await h.server.ensureRunning();
    expect(second).toBe(first);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('stop() kills the process tree and clears state', async () => {
    const h = await makeHarness();
    await h.server.ensureRunning();
    await h.server.stop();
    expect(h.killTree).toHaveBeenCalledWith(FAKE_PID);
    expect(h.server.isRunning()).toBe(false);
  });
});
