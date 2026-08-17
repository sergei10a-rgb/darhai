/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The LM Studio serve path must work with NO production wiring.
 *
 * `cookbookServeSingleton.ts` builds the service without a `probeLmStudio`
 * dep - deliberately, because LM Studio needs nothing from Electron. That only
 * holds while the service DEFAULTS the dep to the real probe, and every other
 * test in this suite stubs it, so a deleted default would leave the whole
 * suite green and LM Studio serving dead in the shipped app. This file is the
 * one that would go red: it stubs only the network seam
 * (`defaultFetchLmStudioModels`) and drives the real
 * `probeLmStudioServer` -> service chain.
 *
 * The body below is a verbatim-shaped excerpt of what the reference machine's
 * LM Studio actually answered on `GET /api/v0/models` (fields and spellings
 * unchanged), so it doubles as proof the parser reads the real payload.
 */

import { describe, expect, it, vi } from 'vitest';
import { CookbookServeService, type CookbookServeDeps } from '@process/services/cookbook/CookbookServeService';
import { LM_STUDIO_MODELS_URL } from '@process/services/cookbook/lmStudioDetect';
import type { LocalServeManager } from '@process/services/cookbook/LocalServeManager';
import type { ModelDownloadManager } from '@process/services/cookbook/ModelDownloadManager';
import type { CatalogModel, HardwareProfile } from '@process/services/hwfit';

const { fetchModels, execServerStatus } = vi.hoisted(() => ({
  // The CLI seam is stubbed alongside the network seam: the default probe now
  // asks `lms server status --json` for the configured port first, and this
  // test must stay hermetic on a machine that HAS LM Studio (a real status
  // call would report whatever port the developer's install uses).
  execServerStatus: vi.fn(async (_cliPath: string) => null as string | null),
  fetchModels: vi.fn(async (_url: string) => ({
    data: [
      {
        id: 'qwen/qwen3.6-27b',
        object: 'model',
        type: 'vlm',
        publisher: 'qwen',
        arch: 'qwen35',
        compatibility_type: 'gguf',
        quantization: 'Q4_K_M',
        state: 'not-loaded',
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
        state: 'not-loaded',
        max_context_length: 2048,
      },
    ],
    object: 'list',
  })),
}));

vi.mock('@process/services/cookbook/lmStudioDetect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@process/services/cookbook/lmStudioDetect')>();
  return { ...actual, defaultFetchLmStudioModels: fetchModels, defaultExecLmStudioServerStatus: execServerStatus };
});

const MODEL: CatalogModel = {
  name: 'Qwen/Qwen3.6-27B',
  provider: 'Qwen',
  parameterCount: '27B',
  quantization: 'Q4_K_M',
};

const HARDWARE: HardwareProfile = {
  totalRamGb: 64,
  availableRamGb: 32,
  cpuCores: 16,
  cpuName: 'Test CPU',
  hasGpu: true,
  gpuName: 'Test GPU',
  gpuVramGb: 8,
  gpuCount: 1,
  gpus: [{ index: 0, name: 'Test GPU', vramGb: 8 }],
  backend: 'cuda',
  platform: 'windows',
  gpuError: null,
};

describe('LM Studio serve defaults (no production wiring)', () => {
  it('reaches LM Studio through the real probe when no dep is injected', async () => {
    const upsert = vi.fn();
    const deps: CookbookServeDeps = {
      downloadManager: {
        isDownloaded: () => false,
        download: vi.fn(),
        cancel: () => false,
      } as unknown as ModelDownloadManager,
      serveManager: {
        detectAvailability: async () => ({
          ollama: false,
          llamaServer: false,
          vllm: false,
          lmStudioServing: true,
          lmStudioInstalled: true,
        }),
        stop: vi.fn(async () => undefined),
      } as unknown as LocalServeManager,
      getCatalog: () => [MODEL],
      getRepo: () => ({
        getRegistryProvider: () => null,
        upsertRegistryProvider: upsert,
        updateRegistryProviderState: vi.fn(),
        replaceRegistryCatalog: vi.fn(),
      }),
      getGgufDir: () => '/cache/gguf',
      getHardware: async () => HARDWARE,
      arch: 'x64',
      // NOTE: no `probeLmStudio` - exactly like cookbookServeSingleton.ts.
    };

    const status = await new CookbookServeService(deps).serve(MODEL.name);

    expect(fetchModels).toHaveBeenCalledWith(LM_STUDIO_MODELS_URL);
    expect(status.state).toBe('ready');
    expect(status.backend).toBe('lm-studio');
    expect(status.servedModel).toBe('qwen/qwen3.6-27b');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ creds: { key: '', baseUrl: 'http://127.0.0.1:1234/v1' } })
    );
  });
});
