/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isLlamaServerProvisionable,
  isVllmViable,
  selectBackend,
  VLLM_MIN_VRAM_GB,
  type BackendAvailability,
  type BackendPolicyInput,
} from '@process/services/cookbook/backendPolicy';

const availability = (over: Partial<BackendAvailability> = {}): BackendAvailability => ({
  ollama: false,
  llamaServer: false,
  vllm: false,
  ...over,
});

const input = (over: Partial<BackendPolicyInput> = {}): BackendPolicyInput => ({
  platform: 'linux',
  hwBackend: 'cuda',
  vramGb: 24,
  available: availability(),
  canProvisionLlamaServer: true,
  ...over,
});

describe('isVllmViable', () => {
  it('is viable on Linux + CUDA + ample VRAM with vllm installed', () => {
    expect(isVllmViable(input({ vramGb: 24, available: availability({ vllm: true }) }))).toBe(true);
  });
  it('needs at least VLLM_MIN_VRAM_GB of VRAM', () => {
    expect(isVllmViable(input({ vramGb: VLLM_MIN_VRAM_GB - 1, available: availability({ vllm: true }) }))).toBe(false);
    expect(isVllmViable(input({ vramGb: VLLM_MIN_VRAM_GB, available: availability({ vllm: true }) }))).toBe(true);
  });
  it('is not viable off Linux (e.g. Windows) even with a big CUDA GPU', () => {
    expect(isVllmViable(input({ platform: 'windows', vramGb: 48, available: availability({ vllm: true }) }))).toBe(
      false
    );
  });
  it('is not viable without a CUDA GPU', () => {
    expect(isVllmViable(input({ hwBackend: 'rocm', available: availability({ vllm: true }) }))).toBe(false);
    expect(isVllmViable(input({ hwBackend: 'metal', available: availability({ vllm: true }) }))).toBe(false);
  });
  it('is not viable when the vllm binary is missing', () => {
    expect(isVllmViable(input({ vramGb: 48, available: availability({ vllm: false }) }))).toBe(false);
  });
});

describe('selectBackend', () => {
  it('8GB Windows box with only llama-server -> llama-server', () => {
    const sel = selectBackend(
      input({ platform: 'windows', hwBackend: 'cpu_x86', vramGb: 8, available: availability({ llamaServer: true }) })
    );
    // Already installed, so it is viable and NOT also provisionable - a backend
    // is never in both lists, or the UI would offer to install what is running.
    expect(sel).toEqual({ chosen: 'llama-server', viable: ['llama-server'], provisionable: [] });
  });

  it('24GB Linux CUDA box with vllm installed -> vllm is chosen, offered ahead of others', () => {
    const sel = selectBackend(
      input({ vramGb: 24, available: availability({ vllm: true, ollama: true, llamaServer: true }) })
    );
    expect(sel.chosen).toBe('vllm');
    expect(sel.viable).toEqual(['vllm', 'ollama', 'llama-server']);
  });

  it('ollama present but vllm not viable (Windows) -> ollama is chosen', () => {
    const sel = selectBackend(
      input({
        platform: 'windows',
        hwBackend: 'cuda',
        vramGb: 24,
        available: availability({ ollama: true, llamaServer: true, vllm: true }),
      })
    );
    expect(sel.chosen).toBe('ollama');
    expect(sel.viable).toEqual(['ollama', 'llama-server']);
  });

  it('big Linux CUDA box WITHOUT vllm installed -> falls back to ollama/llama-server', () => {
    const sel = selectBackend(input({ vramGb: 80, available: availability({ ollama: true, llamaServer: true }) }));
    expect(sel.chosen).toBe('ollama');
    expect(sel.viable).toEqual(['ollama', 'llama-server']);
  });

  it('nothing installed -> none, no viable backends', () => {
    const sel = selectBackend(input({ vramGb: 8, available: availability() }));
    // Unchanged on purpose: `chosen: 'none'` is what opens the one-press
    // provisioning path, and `viable: []` is what keeps the word "llama.cpp"
    // off a screen whose whole promise is that the user never needs it.
    expect(sel.chosen).toBe('none');
    expect(sel.viable).toEqual([]);
    expect(sel.provisionable).toEqual(['llama-server']);
  });
});

/**
 * The user's right to choose Darhai's own llama.cpp.
 *
 * The product rule, in the owner's words: someone who knows Ollama or LM Studio
 * must still be able to connect those, and a machine with NEITHER can run a
 * model immediately because llama.cpp is inside Darhai. Building the choice list
 * from "what is installed" alone broke the first half of that for everyone in
 * the middle - a host with Ollama on it got `viable: ['ollama']`, so llama.cpp
 * was absent from the chooser AND `chosen` was not `'none'`, which is the only
 * value that opens the provisioning path. There was no route to it at all.
 */
describe('selectBackend: llama.cpp is offerable because Darhai ships it', () => {
  it('offers it on a host that has ollama and no llama-server', () => {
    const sel = selectBackend(
      input({
        platform: 'windows',
        hwBackend: 'cuda',
        vramGb: 8,
        available: availability({ ollama: true }),
      })
    );
    // The regression: this used to be the whole answer, with no llama.cpp in it.
    expect(sel.viable).toEqual(['ollama']);
    expect(sel.chosen).toBe('ollama');
    // ...and this is the route that was missing.
    expect(sel.provisionable).toEqual(['llama-server']);
  });

  it('offers it alongside vllm on a big Linux CUDA box', () => {
    const sel = selectBackend(input({ vramGb: 80, available: availability({ vllm: true, ollama: true }) }));
    expect(sel.chosen).toBe('vllm');
    expect(sel.provisionable).toEqual(['llama-server']);
  });

  it('offers nothing to install on a target llama.cpp publishes no build for', () => {
    const sel = selectBackend(input({ available: availability({ ollama: true }), canProvisionLlamaServer: false }));
    expect(sel.provisionable).toEqual([]);
    expect(sel.viable).toEqual(['ollama']);
  });
});

describe('isLlamaServerProvisionable', () => {
  it('is true for every platform + arch llama.cpp publishes a build for', () => {
    for (const platform of ['windows', 'macos', 'linux'] as const) {
      for (const arch of ['x64', 'arm64']) {
        expect(isLlamaServerProvisionable(platform, arch), `${platform}/${arch}`).toBe(true);
      }
    }
  });

  it('is false for a platform or architecture with no published build', () => {
    // `'unknown'` is hwfit's own value for a host it could not type, and a
    // 32-bit build has never been published - neither may be offered as
    // installable, because the plan call would only come back "no build".
    expect(isLlamaServerProvisionable('unknown', 'x64')).toBe(false);
    expect(isLlamaServerProvisionable('windows', 'ia32')).toBe(false);
    expect(isLlamaServerProvisionable('linux', 'arm')).toBe(false);
  });
});
