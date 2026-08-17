/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LM Studio detection, driven in BOTH directions.
 *
 * A detector that only ever sees a machine with the thing installed is not
 * tested - it could be `() => true`. So every case here comes in a pair: a real
 * `lms` on a real disk that is FOUND, and an empty PATH plus a home directory
 * that does not exist where the same code answers null.
 *
 * The filesystem cases wire the REAL `resolveOnPath` from LocalServeManager
 * against a REAL temp tree, with PATH narrowed to a directory this test made -
 * so nothing on the developer's own machine (this repo's reference box HAS LM
 * Studio installed and serving) can make an assertion pass by accident.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveOnPath } from '@process/services/cookbook/LocalServeManager';
import {
  LM_STUDIO_BASE_URL,
  LM_STUDIO_MODELS_URL,
  defaultLmStudioServingProbe,
  detectLmStudio,
  detectLmStudioCli,
  detectLmStudioPort,
  lmStudioCliCandidates,
  lmStudioModelsUrl,
  parseLmStudioStatusPort,
  probeLmStudioServer,
  type LmStudioDetectDeps,
} from '@process/services/cookbook/lmStudioDetect';

/**
 * `lms server status --json` stdout, verbatim as the reference machine's CLI
 * answered it (2026-08-17, exit 0 in all three states): server up, server
 * stopped - the `port` field is the CONFIGURED port and is present either way -
 * and server restarted on a moved port via `lms server start --port 12399`.
 */
const STATUS_UP = '{"running":true,"port":1234}';
const STATUS_DOWN = '{"running":false,"port":1234}';
const STATUS_MOVED = '{"running":true,"port":12399}';

/**
 * A verbatim slice of `GET http://127.0.0.1:1234/api/v0/models` as the live LM
 * Studio on the reference machine answered it (2026-08-16, HTTP 200, 8 models).
 * Kept in its native snake_case so the mapping in `toModel` is exercised rather
 * than assumed - and `text-embedding-nomic-embed-text-v1.5` is included because
 * it is the entry with NO `capabilities` key at all.
 */
const LIVE_BODY = {
  data: [
    {
      id: 'openai/gpt-oss-20b',
      object: 'model',
      type: 'llm',
      publisher: 'openai',
      arch: 'gpt-oss',
      compatibility_type: 'gguf',
      quantization: 'MXFP4',
      state: 'not-loaded',
      max_context_length: 131072,
      capabilities: ['tool_use'],
    },
    {
      id: 'qwen/qwen3.6-27b',
      object: 'model',
      type: 'vlm',
      publisher: 'qwen',
      arch: 'qwen35',
      compatibility_type: 'gguf',
      quantization: 'Q4_K_M',
      state: 'loaded',
      max_context_length: 262144,
      capabilities: ['tool_use'],
    },
    {
      id: 'text-embedding-nomic-embed-text-v1.5',
      object: 'model',
      type: 'embeddings',
      publisher: 'nomic-ai',
      arch: 'nomic-bert',
      compatibility_type: 'gguf',
      quantization: 'Q4_K_M',
      state: 'not-loaded',
      max_context_length: 2048,
    },
  ],
  object: 'list',
};

/** A machine with nothing: no PATH to search, and a home that does not exist. */
const NO_MACHINE: LmStudioDetectDeps = {
  // The REAL resolver, handed a genuinely empty PATH.
  resolveCommandPath: (cmd) => resolveOnPath(cmd, ''),
  homeDir: () => path.join(os.tmpdir(), 'darhai-no-such-home-9d3f1a'),
  platform: () => process.platform,
  fetchModels: async () => null,
  // The property that must not regress: a host with no CLI never pays for a
  // CLI start-up. A call here is a loud failure, not a stubbed answer.
  execServerStatus: async () => {
    throw new Error('execServerStatus must not run on a machine with no lms CLI');
  },
};

let home = '';
let binDir = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-lms-'));
  binDir = path.join(home, '.lmstudio', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Write a runnable stub `lms` under the fixture home, and return its path. */
function writeCli(name: string, dir = binDir): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\n');
  // POSIX `access(X_OK)` needs the bit; Windows ignores it. Without this the
  // fixture would be invisible to the real resolver on Linux and macOS CI.
  fs.chmodSync(p, 0o755);
  return p;
}

describe('lmStudioCliCandidates', () => {
  it('covers Windows, macOS and Linux without baking in any real home', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const found = lmStudioCliCandidates('/h', platform);
      // The modern home on all three, and the pre-rename cache dir an install
      // that was never re-bootstrapped still uses.
      expect(
        found.some((c) => c.includes(path.join('.lmstudio', 'bin'))),
        platform
      ).toBe(true);
      expect(
        found.some((c) => c.includes(path.join('.cache', 'lm-studio', 'bin'))),
        platform
      ).toBe(true);
      // Both spellings at every root, because guessing wrong reads as "not installed".
      expect(
        found.some((c) => c.endsWith('lms')),
        platform
      ).toBe(true);
      expect(
        found.some((c) => c.endsWith('lms.exe')),
        platform
      ).toBe(true);
      // Every candidate is under the home it was GIVEN.
      expect(
        found.every((c) => c.startsWith(path.join('/h', ''))),
        `${platform}: ${found.join()}`
      ).toBe(true);
    }
  });

  it('puts the .exe first on Windows, the bare name first elsewhere', () => {
    expect(path.basename(lmStudioCliCandidates('/h', 'win32')[0])).toBe('lms.exe');
    expect(path.basename(lmStudioCliCandidates('/h', 'linux')[0])).toBe('lms');
  });

  it('returns nothing rather than searching "/" when there is no home', () => {
    expect(lmStudioCliCandidates('', 'linux')).toEqual([]);
  });
});

describe('detectLmStudioCli: a real binary on a real disk, both directions', () => {
  it('FINDS a bootstrapped install through PATH', () => {
    const expected = writeCli(process.platform === 'win32' ? 'lms.exe' : 'lms');
    const found = detectLmStudioCli({
      // PATH is exactly the fixture dir - nothing of the developer's own.
      resolveCommandPath: (cmd) => resolveOnPath(cmd, binDir),
      homeDir: () => path.join(home, 'unused'),
      platform: () => process.platform,
    });
    expect(found).toBe(expected);
  });

  it('FINDS a never-bootstrapped install through the home directory alone', () => {
    const expected = writeCli(process.platform === 'win32' ? 'lms.exe' : 'lms');
    const found = detectLmStudioCli({
      // Empty PATH: only the home-directory candidates can succeed. This is the
      // case that exists because LM Studio adds `lms` to PATH only when the
      // user runs `lms bootstrap`.
      resolveCommandPath: (cmd) => resolveOnPath(cmd, ''),
      homeDir: () => home,
      platform: () => process.platform,
    });
    expect(found).toBe(expected);
  });

  it('FINDS a pre-rename install under ~/.cache/lm-studio/bin', () => {
    const legacy = path.join(home, '.cache', 'lm-studio', 'bin');
    fs.mkdirSync(legacy, { recursive: true });
    const expected = writeCli(process.platform === 'win32' ? 'lms.exe' : 'lms', legacy);
    const found = detectLmStudioCli({
      resolveCommandPath: (cmd) => resolveOnPath(cmd, ''),
      homeDir: () => home,
      platform: () => process.platform,
    });
    expect(found).toBe(expected);
  });

  it('FINDS an `lms.exe`-only directory that is ON PATH - the measured Windows case', () => {
    // MEASURED on the reference machine: `~/.lmstudio/bin` was on the user's
    // PATH and held ONLY `lms.exe`, so probing the bare name `lms` resolved to
    // null. A one-name probe would have reported "no LM Studio" on a machine
    // that has it, serving, with eight models.
    const expected = writeCli('lms.exe');
    expect(resolveOnPath('lms', binDir)).toBeNull();
    const found = detectLmStudioCli({
      resolveCommandPath: (cmd) => resolveOnPath(cmd, binDir),
      homeDir: () => path.join(home, 'unused'),
      platform: () => process.platform,
    });
    expect(found).toBe(expected);
  });

  it('is NULL on a machine with an empty PATH and no such home', () => {
    // The other direction. Nothing was written under `binDir` in this case, and
    // the home does not exist at all.
    expect(detectLmStudioCli(NO_MACHINE)).toBeNull();
  });

  it('is NULL when the home exists but holds no lms at all', () => {
    expect(
      detectLmStudioCli({
        resolveCommandPath: (cmd) => resolveOnPath(cmd, ''),
        homeDir: () => home,
        platform: () => process.platform,
      })
    ).toBeNull();
  });
});

describe('probeLmStudioServer', () => {
  it('reads LM Studio own endpoint, not the OpenAI shim', () => {
    expect(LM_STUDIO_MODELS_URL).toBe('http://127.0.0.1:1234/api/v0/models');
    expect(LM_STUDIO_BASE_URL).toBe('http://127.0.0.1:1234/v1');
    expect(lmStudioModelsUrl(12399)).toBe('http://127.0.0.1:12399/api/v0/models');
  });

  it('probes the port it is GIVEN - a moved server is probed where it lives', async () => {
    const seen: string[] = [];
    const probe = await probeLmStudioServer(
      {
        fetchModels: async (url) => {
          seen.push(url);
          return LIVE_BODY;
        },
      },
      12399
    );
    expect(seen).toEqual(['http://127.0.0.1:12399/api/v0/models']);
    expect(probe.serving).toBe(true);
  });

  it('parses the live payload, including the fields the /v1 shim cannot carry', async () => {
    const seen: string[] = [];
    const probe = await probeLmStudioServer({
      fetchModels: async (url) => {
        seen.push(url);
        return LIVE_BODY;
      },
    });
    expect(seen).toEqual([LM_STUDIO_MODELS_URL]);
    expect(probe.serving).toBe(true);
    expect(probe.models.map((m) => m.id)).toEqual([
      'openai/gpt-oss-20b',
      'qwen/qwen3.6-27b',
      'text-embedding-nomic-embed-text-v1.5',
    ]);
    expect(probe.models[0]).toEqual({
      id: 'openai/gpt-oss-20b',
      type: 'llm',
      state: 'not-loaded',
      publisher: 'openai',
      arch: 'gpt-oss',
      quantization: 'MXFP4',
      maxContextLength: 131072,
      capabilities: ['tool_use'],
    });
    // `state` is the field that says a model is already in memory, and it is
    // the reason the native endpoint is worth reading at all.
    expect(probe.models[1].state).toBe('loaded');
    expect(probe.models[1].type).toBe('vlm');
    // An embeddings entry has no `capabilities` key; it must not be invented.
    expect(probe.models[2].capabilities).toBeUndefined();
  });

  it('is NOT serving when nothing answers', async () => {
    expect(await probeLmStudioServer({ fetchModels: async () => null })).toEqual({ serving: false, models: [] });
  });

  it('is NOT serving when something on 1234 answers with the wrong shape', async () => {
    // A proxy or a different app squatting the port. 200 is not enough - the
    // body has to be LM Studio's model list, or Darhai would claim LM Studio is
    // available and then route a chat into whatever that is.
    expect(await probeLmStudioServer({ fetchModels: async () => ({ ok: true }) })).toEqual({
      serving: false,
      models: [],
    });
    expect(await probeLmStudioServer({ fetchModels: async () => '<html>hi</html>' })).toEqual({
      serving: false,
      models: [],
    });
  });

  it('IS serving with zero models - up but empty is not the same as down', async () => {
    expect(await probeLmStudioServer({ fetchModels: async () => ({ data: [], object: 'list' }) })).toEqual({
      serving: true,
      models: [],
    });
  });

  it('drops entries with no usable id instead of inventing one', async () => {
    const probe = await probeLmStudioServer({
      fetchModels: async () => ({ data: [{ id: '' }, null, 'nope', { id: 'real' }] }),
    });
    expect(probe.models.map((m) => m.id)).toEqual(['real']);
    // Defaults for a model that reported nothing else about itself.
    expect(probe.models[0].type).toBe('llm');
    expect(probe.models[0].state).toBe('not-loaded');
  });
});

describe('parseLmStudioStatusPort', () => {
  it('reads all three measured shapes: server up, server stopped, server moved', () => {
    expect(parseLmStudioStatusPort(STATUS_UP)).toBe(1234);
    // Stopped is NOT portless: the field is the configured port (measured).
    expect(parseLmStudioStatusPort(STATUS_DOWN)).toBe(1234);
    expect(parseLmStudioStatusPort(STATUS_MOVED)).toBe(12399);
    // The CLI ends its stdout with a newline; JSON.parse must not care.
    expect(parseLmStudioStatusPort(`${STATUS_UP}\n`)).toBe(1234);
  });

  it('answers null for anything that does not carry a valid TCP port', () => {
    expect(parseLmStudioStatusPort('')).toBeNull();
    expect(parseLmStudioStatusPort('lms: command failed')).toBeNull();
    expect(parseLmStudioStatusPort('null')).toBeNull();
    expect(parseLmStudioStatusPort('"1234"')).toBeNull();
    expect(parseLmStudioStatusPort('{"running":true}')).toBeNull();
    expect(parseLmStudioStatusPort('{"port":"1234"}')).toBeNull();
    expect(parseLmStudioStatusPort('{"port":0}')).toBeNull();
    expect(parseLmStudioStatusPort('{"port":65536}')).toBeNull();
    expect(parseLmStudioStatusPort('{"port":1234.5}')).toBeNull();
  });
});

describe('detectLmStudioPort', () => {
  it('never runs the CLI when there is no CLI - the bare host stays untaxed', async () => {
    const exec = vi.fn(async () => STATUS_MOVED);
    expect(await detectLmStudioPort(null, { execServerStatus: exec })).toBe(1234);
    expect(exec).not.toHaveBeenCalled();
  });

  it('reads the configured port through the found CLI, once', async () => {
    const exec = vi.fn(async () => STATUS_MOVED);
    expect(await detectLmStudioPort('/somewhere/lms', { execServerStatus: exec })).toBe(12399);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('/somewhere/lms');
  });

  it('falls back to 1234 when the CLI fails or answers garbage', async () => {
    expect(await detectLmStudioPort('/somewhere/lms', { execServerStatus: async () => null })).toBe(1234);
    expect(await detectLmStudioPort('/somewhere/lms', { execServerStatus: async () => 'not json' })).toBe(1234);
  });
});

describe('detectLmStudio: installed and serving move independently', () => {
  const withCli = (
    fetchModels: LmStudioDetectDeps['fetchModels'],
    execServerStatus: LmStudioDetectDeps['execServerStatus'] = async () => STATUS_UP
  ): LmStudioDetectDeps => ({
    resolveCommandPath: (cmd) => resolveOnPath(cmd, ''),
    homeDir: () => home,
    platform: () => process.platform,
    fetchModels,
    execServerStatus,
  });

  it('installed AND serving', async () => {
    const cli = writeCli(process.platform === 'win32' ? 'lms.exe' : 'lms');
    expect(await detectLmStudio(withCli(async () => LIVE_BODY))).toEqual({
      installed: true,
      serving: true,
      cliPath: cli,
    });
  });

  it('installed, NOT serving - the host that gets offered "start it"', async () => {
    const cli = writeCli(process.platform === 'win32' ? 'lms.exe' : 'lms');
    expect(
      await detectLmStudio(
        withCli(
          async () => null,
          // The measured stopped-server answer: still exit 0, still carries the port.
          async () => STATUS_DOWN
        )
      )
    ).toEqual({
      installed: true,
      serving: false,
      cliPath: cli,
    });
  });

  it('serving, NOT installed - a portable copy the CLI search cannot see', async () => {
    expect(await detectLmStudio(withCli(async () => LIVE_BODY, NO_MACHINE.execServerStatus))).toEqual({
      installed: false,
      serving: true,
      cliPath: null,
    });
  });

  it('neither - a machine with no LM Studio at all', async () => {
    expect(await detectLmStudio(NO_MACHINE)).toEqual({ installed: false, serving: false, cliPath: null });
  });

  it('aims the probe at the port the CLI reports - the measured moved-server host', async () => {
    // MEASURED 2026-08-17: after `lms server start --port 12399`, /api/v0/models
    // answered 8 models on 12399 while 1234 REFUSED. This fetch stub is that
    // host: only the moved port answers, so probing 1234 would read as down.
    writeCli(process.platform === 'win32' ? 'lms.exe' : 'lms');
    const seen: string[] = [];
    const result = await detectLmStudio(
      withCli(
        async (url) => {
          seen.push(url);
          return url === lmStudioModelsUrl(12399) ? LIVE_BODY : null;
        },
        async () => STATUS_MOVED
      )
    );
    expect(seen).toEqual([lmStudioModelsUrl(12399)]);
    expect(result.serving).toBe(true);
  });

  it('keeps the 1234 fallback when the CLI is found but cannot answer', async () => {
    writeCli(process.platform === 'win32' ? 'lms.exe' : 'lms');
    const seen: string[] = [];
    const result = await detectLmStudio(
      withCli(
        async (url) => {
          seen.push(url);
          return LIVE_BODY;
        },
        async () => null
      )
    );
    // Exactly the pre-port-detection behaviour: probe the default port.
    expect(seen).toEqual([LM_STUDIO_MODELS_URL]);
    expect(result.serving).toBe(true);
  });
});

describe('defaultLmStudioServingProbe (the availability seam LocalServeManager wires)', () => {
  it('runs CLI -> port -> probe once each, and follows a moved port', async () => {
    writeCli(process.platform === 'win32' ? 'lms.exe' : 'lms');
    const exec = vi.fn(async () => STATUS_MOVED);
    const seen: string[] = [];
    const serving = await defaultLmStudioServingProbe({
      resolveCommandPath: (cmd) => resolveOnPath(cmd, ''),
      homeDir: () => home,
      platform: () => process.platform,
      fetchModels: async (url) => {
        seen.push(url);
        return url === lmStudioModelsUrl(12399) ? LIVE_BODY : null;
      },
      execServerStatus: exec,
    });
    expect(serving).toBe(true);
    // One status call per availability read - the cost stays bounded.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([lmStudioModelsUrl(12399)]);
  });

  it('stays a cheap refusal on a machine with no LM Studio at all', async () => {
    const seen: string[] = [];
    const serving = await defaultLmStudioServingProbe({
      ...NO_MACHINE,
      fetchModels: async (url) => {
        seen.push(url);
        return null;
      },
    });
    expect(serving).toBe(false);
    // No CLI -> no status call (NO_MACHINE throws on one) -> default-port probe.
    expect(seen).toEqual([LM_STUDIO_MODELS_URL]);
  });
});
