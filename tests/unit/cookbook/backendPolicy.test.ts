/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
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
    expect(sel).toEqual({ chosen: 'llama-server', viable: ['llama-server'] });
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
    expect(sel).toEqual({ chosen: 'none', viable: [] });
  });
});
