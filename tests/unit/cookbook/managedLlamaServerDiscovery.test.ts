/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The seam that makes "install Darhai and nothing else" true.
 *
 * `LocalServeManager.resolveLlamaServer()` searches PATH and then the
 * `llamaServerCandidates` dep, which shipped hard-coded to `() => []`. On a
 * machine with no hand-installed llama.cpp that made `detectAvailability()`
 * report `llamaServer: false`, the backend selector return `chosen: 'none'`,
 * and the whole serve flow fall through to printing a shell command.
 *
 * Production now injects `llamaServerCandidates(app.getPath('userData'))` in
 * cookbookServeSingleton.ts. This test wires the REAL function - not a copy of
 * its rules - against a real install tree on disk, with a `resolveCommandPath`
 * that refuses bare names so nothing on the developer's own PATH can make the
 * assertion pass by accident.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The real shellEnv pulls platform services; stub it so importing the manager
// stays out of Electron. Tests inject full deps anyway.
vi.mock('@process/utils/shellEnv', () => ({ getEnhancedEnv: () => ({}) }));

import { LocalServeManager, type LocalServeDeps } from '@process/services/cookbook/LocalServeManager';
import {
  RECEIPT_NAME,
  RECEIPT_SCHEMA,
  installDir,
  llamaServerCandidates,
  serverBinaryName,
} from '@process/services/llamacpp';

const TAG = 'b10437';

let userData = '';

/** Lay down a complete, receipt-backed install exactly as the provisioner does. */
function writeInstall(tag: string): string {
  const dir = installDir(userData, tag);
  fs.mkdirSync(dir, { recursive: true });
  const binary = serverBinaryName(process.platform === 'win32' ? 'win32' : 'linux');
  const serverPath = path.join(dir, binary);
  fs.writeFileSync(serverPath, '#!/bin/sh\n');
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
      assets: [{ name: `llama-${tag}-bin.zip`, sha256: 'a'.repeat(64), bytes: 1024 }],
      files: [binary],
      requires: [],
      installedAt: '2026-08-15T00:00:00.000Z',
    })
  );
  return serverPath;
}

/**
 * Deps for a machine with NOTHING on PATH: only absolute paths that exist on
 * disk resolve. Without this, a developer box that happens to have llama.cpp
 * installed would make every assertion below vacuous.
 */
function depsWithEmptyPath(candidates: () => string[]): LocalServeDeps {
  return {
    spawn: () => {
      throw new Error('spawn must not be called by these tests');
    },
    allocatePort: async () => 51000,
    healthProbe: async () => false,
    resolveCommandPath: (cmd) => (path.isAbsolute(cmd) && fs.existsSync(cmd) ? cmd : null),
    // These tests are about which binary is FOUND, not what it can do, and the
    // fixture binary is a stub shell script - probing it for real would execute it.
    probeHelpText: () => '',
    llamaServerCandidates: candidates,
    // "Nothing on PATH" has to mean nothing on this machine either: both LM
    // Studio seams default to real probes (a home-directory scan and a loopback
    // fetch), so a developer box running LM Studio would otherwise answer
    // differently from CI on assertions that are not about LM Studio at all.
    lmStudioCliCandidates: () => [],
    lmStudioServingProbe: async () => false,
    env: () => ({}),
    readyTimeoutMs: 1000,
  };
}

/** The LM Studio half of `detectAvailability`, absent on these fixtures. */
const NO_LM_STUDIO = { lmStudioServing: false, lmStudioInstalled: false };

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-llama-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('Darhai finds the llama-server it installed itself', () => {
  it('reports llamaServer: true when only Darhai own copy exists', async () => {
    writeInstall(TAG);
    const mgr = new LocalServeManager(depsWithEmptyPath(() => llamaServerCandidates(userData)));
    expect(await mgr.detectAvailability()).toEqual({ ollama: false, llamaServer: true, vllm: false, ...NO_LM_STUDIO });
  });

  it('resolves the managed binary path itself, not just a boolean', () => {
    const expected = writeInstall(TAG);
    const mgr = new LocalServeManager(depsWithEmptyPath(() => llamaServerCandidates(userData)));
    expect(mgr.resolveLlamaServer()).toBe(expected);
  });

  it('prefers the newest installed release when two are present', () => {
    writeInstall('b10437');
    const newer = writeInstall('b10500');
    const mgr = new LocalServeManager(depsWithEmptyPath(() => llamaServerCandidates(userData)));
    expect(mgr.resolveLlamaServer()).toBe(newer);
  });

  it('reports llamaServer: false when the candidate list is empty - the shipped behaviour', async () => {
    // The pre-wiring default. Named so the passing test above cannot be
    // explained by anything other than the candidate list.
    writeInstall(TAG);
    const mgr = new LocalServeManager(depsWithEmptyPath(() => []));
    expect(await mgr.detectAvailability()).toEqual({ ollama: false, llamaServer: false, vllm: false, ...NO_LM_STUDIO });
  });

  it('ignores a half-installed tree that never got its receipt', async () => {
    const dir = installDir(userData, TAG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, serverBinaryName(process.platform === 'win32' ? 'win32' : 'linux')), 'x');
    const mgr = new LocalServeManager(depsWithEmptyPath(() => llamaServerCandidates(userData)));
    expect(await mgr.detectAvailability()).toEqual({ ollama: false, llamaServer: false, vllm: false, ...NO_LM_STUDIO });
  });
});
