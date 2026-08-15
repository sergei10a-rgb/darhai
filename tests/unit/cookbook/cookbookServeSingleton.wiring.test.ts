/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The production wiring itself, not just the function it wires.
 *
 * `managedLlamaServerDiscovery.test.ts` proves that a `LocalServeManager` given
 * `llamaServerCandidates(userData)` finds Darhai's own binary. That is only
 * half the claim: the manager the app actually runs is built in
 * `cookbookServeSingleton.ts`, and for the entire life of that file the dep was
 * left at its `() => []` default. This test captures the deps the singleton
 * really passes and runs them against a real install tree, so removing the
 * wiring turns the whole feature off AND turns this red.
 *
 * Everything except `LocalServeManager` and the llamacpp layout is mocked -
 * the singleton otherwise drags in the model registry, the DB and Electron.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type os from 'node:os';
import path from 'node:path';
import { RECEIPT_NAME, RECEIPT_SCHEMA, installDir, serverBinaryName } from '@process/services/llamacpp';

// Hoisted: the singleton is imported statically below, and ESM hoists that
// import above ordinary `const` declarations - both of these are read while it
// evaluates, so they must exist before any module body runs.
const { userData, captured } = vi.hoisted(() => {
  const nodeFs = require('node:fs') as typeof fs;
  const nodeOs = require('node:os') as typeof os;
  const nodePath = require('node:path') as typeof path;
  return {
    userData: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'darhai-singleton-')),
    /** Deps captured from the real `new LocalServeManager(...)` call. */
    captured: { deps: undefined as { llamaServerCandidates?: () => string[] } | undefined },
  };
});

vi.mock('electron', () => ({ app: { getPath: () => userData } }));
vi.mock('@/common', () => ({
  ipcBridge: {
    cookbook: { onDownloadProgress: { emit: vi.fn() }, onServeStatus: { emit: vi.fn() } },
  },
}));
vi.mock('@process/services/hwfit', () => ({
  getCatalog: (): unknown[] => [],
  scanHardware: async (): Promise<Record<string, unknown>> => ({
    backend: 'cpu_x86',
    platform: 'windows',
    hasGpu: false,
    gpuVramGb: null,
  }),
}));
vi.mock('@process/providers/ipc/modelRegistryIpc', () => ({ getModelRegistryRepository: (): unknown => null }));
// Inert stand-ins: the singleton only has to construct without reaching a DB
// or the network. The `stub` field is what keeps them from being empty classes.
vi.mock('@process/services/cookbook/ModelDownloadManager', () => ({
  ModelDownloadManager: class {
    readonly stub = true;
  },
}));
vi.mock('@process/services/cookbook/CookbookServeService', () => ({
  CookbookServeService: class {
    readonly stub = true;
  },
}));
vi.mock('@process/services/cookbook/LocalServeManager', () => ({
  LocalServeManager: class {
    readonly stub = true;
    constructor(deps?: { llamaServerCandidates?: () => string[] }) {
      captured.deps = deps;
    }
  },
}));

const TAG = 'b10500';

function writeInstall(tag: string): string {
  const dir = installDir(userData, tag);
  fs.mkdirSync(dir, { recursive: true });
  const binary = serverBinaryName(process.platform === 'win32' ? 'win32' : 'linux');
  fs.writeFileSync(path.join(dir, binary), 'x');
  fs.writeFileSync(
    path.join(dir, RECEIPT_NAME),
    JSON.stringify({
      schema: RECEIPT_SCHEMA,
      tag,
      platform: process.platform,
      arch: process.arch,
      requestedBackend: 'cpu_x86',
      acceleration: 'cpu',
      fallback: null,
      serverRelPath: binary,
      assets: [],
      files: [binary],
      requires: [],
      installedAt: '2026-08-15T00:00:00.000Z',
    })
  );
  return path.join(dir, binary);
}

// The module builds its singleton at import time and ESM evaluates it once, so
// the deps are captured here rather than re-imported per test.
import '@process/services/cookbook/cookbookServeSingleton';

afterEach(() => {
  fs.rmSync(installDir(userData, TAG), { recursive: true, force: true });
});

describe('cookbookServeSingleton wires Darhai own llama-server into the serve path', () => {
  it('passes a llamaServerCandidates dep instead of leaving the () => [] default', () => {
    expect(captured.deps).toBeDefined();
    expect(typeof captured.deps.llamaServerCandidates).toBe('function');
  });

  it('the wired dep returns the managed binary once one is installed', () => {
    const expected = writeInstall(TAG);
    expect(captured.deps.llamaServerCandidates()).toEqual([expected]);
  });

  it('the wired dep returns [] when nothing is installed, preserving the old behaviour', () => {
    expect(captured.deps.llamaServerCandidates()).toEqual([]);
  });

  it('re-reads the disk on every call, so a mid-session install is picked up', () => {
    expect(captured.deps.llamaServerCandidates()).toEqual([]);
    const expected = writeInstall(TAG);
    expect(captured.deps.llamaServerCandidates()).toEqual([expected]);
  });
});
