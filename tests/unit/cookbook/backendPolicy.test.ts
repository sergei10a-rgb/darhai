/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isLlamaServerProvisionable,
  isLmStudioProvisionable,
  isLmStudioViable,
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
  lmStudioServing: false,
  lmStudioInstalled: false,
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

/**
 * LM Studio: one of the two runtimes the product owner names by hand.
 *
 * "someone who knows Ollama or LM Studio must be able to connect those" - and
 * until now a machine with LM Studio serving eight models on 1234 got none of
 * them: not in the union, not in availability, not probed. The two-flag shape
 * is what makes the answer honest, because Darhai does not own that process:
 * "LM Studio is here" and "LM Studio is answering" are different facts, and the
 * middle case (here, but its server off) is a real machine that must be offered
 * something other than "install LM Studio".
 */
describe('isLmStudioViable / isLmStudioProvisionable', () => {
  it('is viable when the server answers, whatever the CLI search found', () => {
    // Serving without an `lms` on disk is a REAL host: a portable or relocated
    // install. It can serve, so it is viable - the CLI only buys "start it".
    expect(isLmStudioViable(input({ available: availability({ lmStudioServing: true }) }))).toBe(true);
    expect(
      isLmStudioViable(input({ available: availability({ lmStudioServing: true, lmStudioInstalled: true }) }))
    ).toBe(true);
  });

  it('is not viable when installed but not serving', () => {
    expect(isLmStudioViable(input({ available: availability({ lmStudioInstalled: true }) }))).toBe(false);
  });

  it('is provisionable only when installed AND not already serving', () => {
    expect(isLmStudioProvisionable(input({ available: availability({ lmStudioInstalled: true }) }))).toBe(true);
    // Already serving: it belongs in `viable`, and a backend is never in both.
    expect(
      isLmStudioProvisionable(input({ available: availability({ lmStudioInstalled: true, lmStudioServing: true }) }))
    ).toBe(false);
    // Not installed: there is no `lms` to run, so "start it" cannot be offered.
    expect(isLmStudioProvisionable(input({ available: availability({ lmStudioServing: true }) }))).toBe(false);
    expect(isLmStudioProvisionable(input({ available: availability() }))).toBe(false);
  });
});

describe('selectBackend: LM Studio in the chooser', () => {
  it('a Windows box whose ONLY runtime is LM Studio serving -> lm-studio is chosen', () => {
    const sel = selectBackend(
      input({
        platform: 'windows',
        hwBackend: 'cuda',
        vramGb: 8,
        available: availability({ lmStudioServing: true, lmStudioInstalled: true }),
      })
    );
    // The whole point: this host used to produce `chosen: 'none', viable: []`.
    expect(sel.chosen).toBe('lm-studio');
    expect(sel.viable).toEqual(['lm-studio']);
    // Already usable, so it is not ALSO offered as something to start.
    expect(sel.provisionable).toEqual(['llama-server']);
  });

  it('LM Studio installed but its server off -> provisionable, never viable', () => {
    const sel = selectBackend(
      input({ platform: 'windows', hwBackend: 'cuda', vramGb: 8, available: availability({ lmStudioInstalled: true }) })
    );
    expect(sel.viable).toEqual([]);
    expect(sel.chosen).toBe('none');
    // Ranked the same way `viable` is, so the concatenated chooser reads as one
    // ordered list.
    expect(sel.provisionable).toEqual(['lm-studio', 'llama-server']);
  });

  it('no LM Studio at all is a DIFFERENT host from one with its server off', () => {
    const off = selectBackend(input({ available: availability({ lmStudioInstalled: true }) }));
    const absent = selectBackend(input({ available: availability() }));
    expect(off.provisionable).toContain('lm-studio');
    expect(absent.provisionable).not.toContain('lm-studio');
  });

  /**
   * Placement, asserted rather than described. LM Studio ranks below ollama
   * because this selector serves a model the user picked from Darhai's catalog
   * and ollama can go GET that model (`ollama pull hf.co/<repo>:<quant>`) while
   * LM Studio serves only what it already holds - and because ollama is a
   * background service while LM Studio's server lives inside a GUI app the user
   * can close. It ranks above llama-server because a server already answering
   * beats one Darhai must download a GGUF for and spawn.
   */
  it('ranks vllm > ollama > lm-studio > llama-server', () => {
    const sel = selectBackend(
      input({
        vramGb: 24,
        available: availability({ vllm: true, ollama: true, lmStudioServing: true, llamaServer: true }),
      })
    );
    expect(sel.viable).toEqual(['vllm', 'ollama', 'lm-studio', 'llama-server']);
    expect(sel.chosen).toBe('vllm');
    expect(sel.provisionable).toEqual([]);
  });

  it('defaults to ollama over LM Studio, but still offers LM Studio', () => {
    const sel = selectBackend(
      input({
        platform: 'windows',
        hwBackend: 'cuda',
        vramGb: 8,
        available: availability({ ollama: true, lmStudioServing: true }),
      })
    );
    expect(sel.chosen).toBe('ollama');
    expect(sel.viable).toEqual(['ollama', 'lm-studio']);
  });

  it('prefers LM Studio over a llama-server Darhai would have to spawn', () => {
    const sel = selectBackend(
      input({
        platform: 'windows',
        hwBackend: 'cuda',
        vramGb: 8,
        available: availability({ lmStudioServing: true, llamaServer: true }),
      })
    );
    expect(sel.chosen).toBe('lm-studio');
    expect(sel.viable).toEqual(['lm-studio', 'llama-server']);
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
