/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One backend, five places - this file is the thing that notices when only
 * some of them were edited.
 *
 * `CookbookBackend` is not a type that lives in one file. Adding a member to
 * `COOKBOOK_BACKENDS` obliges FIVE more edits, and tsc catches exactly ONE:
 *
 *   | downstream site                            | what it needs             | catches a miss |
 *   | ------------------------------------------ | ------------------------- | -------------- |
 *   | `BACKEND_LABEL_KEY` (CookbookServeControls) | an i18n KEY               | tsc - a Record |
 *   | 13 × `modelAdvisor.json`                   | the STRING that key names | THIS FILE      |
 *   | `selectBackend` (backendPolicy)            | a branch that emits it    | THIS FILE      |
 *   | `CookbookServeService.serve`               | a dispatch branch         | THIS FILE      |
 *   | `VALID_BACKENDS` (cookbookBridge)          | acceptance over IPC       | construction   |
 *
 * The four non-tsc rows are the whole point. A backend added to the union and
 * the label map, with none of the rest, produces an app that compiles, lints
 * and passes every pre-existing test while:
 *   - rendering `modelAdvisor.cookbook.backend.mlx` as literal screen text in
 *     all 13 languages (i18next falls back to the key),
 *   - never appearing in the chooser on any host,
 *   - falling off the end of `serve()` into the degraded "copy this shell
 *     command" path meant for a machine with NO backend at all, and
 *   - having the IPC validator silently rewrite the user's explicit pick to
 *     `undefined` so the hardware default is served instead.
 *
 * The last one is closed by CONSTRUCTION rather than by an assertion here,
 * which is stronger: `VALID_BACKENDS` is now `new Set(COOKBOOK_BACKENDS)`, and
 * `SERVEABLE_COOKBOOK_BACKENDS` is the union minus `'none'` rather than a
 * second hand-written list. The other three cannot be expressed in the type
 * system, so they are measured here, over the runtime array, exactly as
 * `LLAMA_RUNTIME_FALLBACK_CODES` is.
 *
 * MEASURED by mutation, not assumed - each one restored afterwards:
 *   - a fake `'mlx'` member added to `COOKBOOK_BACKENDS`  -> 16 tests fail here
 *     (13 locales + label map + key-name + reachability), and `tsc` fails at
 *     `BACKEND_LABEL_KEY`;
 *   - `cookbook.backend.lmStudio` deleted from mn-MN only -> 2 tests fail,
 *     naming the locale and the key;
 *   - the `chosen === 'lm-studio'` branch deleted from `serve()` -> 1 test
 *     fails: "serve(override=lm-studio) fell through: expected 'none' to be
 *     'lm-studio'".
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { COOKBOOK_BACKENDS, SERVEABLE_COOKBOOK_BACKENDS } from '../../../src/common/types/cookbook';
import type { CookbookBackend } from '../../../src/common/types/cookbook';
import { selectBackend } from '../../../src/process/services/cookbook/backendPolicy';
import type { BackendPolicyInput } from '../../../src/process/services/cookbook/backendPolicy';
import { CookbookServeService } from '../../../src/process/services/cookbook/CookbookServeService';
import type { LocalServeManager } from '../../../src/process/services/cookbook/LocalServeManager';
import type { ModelDownloadManager } from '../../../src/process/services/cookbook/ModelDownloadManager';
import type { CatalogModel } from '../../../src/process/services/hwfit';

// The component is imported for ONE exported constant, so its two heavy
// neighbours are stubbed rather than loaded. Neither is read by this file.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../../src/renderer/services/FileService', () => ({ formatFileSize: (b: number) => String(b) }));

import { BACKEND_LABEL_KEY } from '../../../src/renderer/pages/model-advisor/CookbookServeControls';

const LOCALES_DIR = join(process.cwd(), 'src/renderer/services/i18n/locales');
const LOCALES = readdirSync(LOCALES_DIR);

function lookup(locale: string, dottedKey: string): unknown {
  const [namespace, ...path] = dottedKey.split('.');
  let node: unknown = JSON.parse(readFileSync(join(LOCALES_DIR, locale, `${namespace}.json`), 'utf-8'));
  for (const part of path) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
  }
  return node;
}

describe('the backend list is one list', () => {
  it('the label map covers the union exactly - no extras, no gaps', () => {
    // `Record<CookbookBackend, string>` already forbids a gap. The EXTRA is what
    // it cannot see: a stale entry for a backend that was renamed or removed
    // keeps its locale strings alive and hides the deletion from every check
    // below, because those iterate the map rather than the union.
    expect(new Set(Object.keys(BACKEND_LABEL_KEY))).toEqual(new Set(COOKBOOK_BACKENDS));
  });

  it("'none' is the only non-serveable member", () => {
    expect(SERVEABLE_COOKBOOK_BACKENDS).toEqual(COOKBOOK_BACKENDS.filter((b) => b !== 'none'));
    expect(SERVEABLE_COOKBOOK_BACKENDS).not.toContain('none' as CookbookBackend);
  });

  it('the guard reads the whole locale set, so a new language cannot be missed', () => {
    // Without this, adding a 14th language would leave it unchecked forever and
    // every assertion below would still be green.
    expect(LOCALES.length).toBe(13);
    expect(LOCALES).toContain('en-US');
    expect(LOCALES).toContain('mn-MN');
  });
});

describe('every backend has a NAME in every language', () => {
  it.each(LOCALES)('%s names every backend', (locale) => {
    for (const backend of COOKBOOK_BACKENDS) {
      const value = lookup(locale, BACKEND_LABEL_KEY[backend]);
      expect(typeof value, `${locale} ${BACKEND_LABEL_KEY[backend]}`).toBe('string');
      expect((value as string).trim().length, `${locale} ${BACKEND_LABEL_KEY[backend]}`).toBeGreaterThan(0);
    }
  });

  it('never renders a key name as the label', () => {
    // The exact failure this class of bug produces: i18next falls back to the
    // key, so a missing string appears on screen as
    // "modelAdvisor.cookbook.backend.mlx" rather than as an error.
    for (const locale of LOCALES) {
      for (const backend of COOKBOOK_BACKENDS) {
        expect(lookup(locale, BACKEND_LABEL_KEY[backend]), `${locale} ${backend}`).not.toContain('modelAdvisor.');
      }
    }
  });
});

/**
 * Hosts chosen to make every branch of `selectBackend` fire at least once
 * between them. Not a re-test of the policy's rules - `backendPolicy.test.ts`
 * owns those, per host and per flag. What is asserted here is coverage: that
 * no member of the union is unreachable on EVERY conceivable host.
 */
const HOSTS: Record<string, BackendPolicyInput> = {
  /** Everything installed and LM Studio's server up: all four can serve now. */
  everything: {
    platform: 'linux',
    hwBackend: 'cuda',
    vramGb: 24,
    available: { ollama: true, llamaServer: true, vllm: true, lmStudioServing: true, lmStudioInstalled: true },
    canProvisionLlamaServer: true,
  },
  /** Nothing serving, but both provisionable acts are available. */
  dormant: {
    platform: 'windows',
    hwBackend: 'cuda',
    vramGb: 8,
    available: { ollama: false, llamaServer: false, vllm: false, lmStudioServing: false, lmStudioInstalled: true },
    canProvisionLlamaServer: true,
  },
};

describe('every serveable backend can actually be reached', () => {
  it('appears in the chooser on at least one host', () => {
    // The chooser is exactly what CookbookServeControls builds:
    // `[...viable, ...provisionable]`. A backend in neither list, on any host,
    // is a name in the type system that no user can ever pick.
    const reachable = new Set<CookbookBackend>();
    for (const input of Object.values(HOSTS)) {
      const selection = selectBackend(input);
      for (const b of [...selection.viable, ...selection.provisionable]) reachable.add(b);
    }
    expect([...reachable].toSorted()).toEqual(SERVEABLE_COOKBOOK_BACKENDS.toSorted());
  });

  it('is never in both lists at once, on any host', () => {
    // `provisionable` means "not usable yet". A backend in both would offer the
    // user an install for something already running.
    for (const [name, input] of Object.entries(HOSTS)) {
      const { viable, provisionable } = selectBackend(input);
      for (const b of provisionable) expect(viable, `${name}: ${b}`).not.toContain(b);
    }
  });

  it('emits both lists in the declared ranking order', () => {
    // The UI concatenates the two and renders them as one ordered list, so the
    // two orders have to be the same order - COOKBOOK_BACKENDS is that order.
    const rank = (b: CookbookBackend): number => COOKBOOK_BACKENDS.indexOf(b);
    for (const [name, input] of Object.entries(HOSTS)) {
      const { viable, provisionable } = selectBackend(input);
      for (const list of [viable, provisionable]) {
        const ranks = list.map(rank);
        expect(ranks, `${name}: ${list.join(',')}`).toEqual(ranks.toSorted((a, b) => a - b));
      }
    }
  });

  it('chooses the highest-ranked viable backend', () => {
    for (const [name, input] of Object.entries(HOSTS)) {
      const { chosen, viable } = selectBackend(input);
      expect(chosen, name).toBe(viable[0] ?? 'none');
    }
  });
});

describe('every serveable backend reaches an implementation', () => {
  /**
   * The fourth duplication site, and the one with no `Record` to protect it:
   * `serve()` is a chain of `if (chosen === '<literal>')` with
   * `serveDegraded()` at the end. A backend with no branch does not throw and
   * does not warn - it falls off the end into the degraded "copy this shell
   * command" path, which is the app's answer for a machine with NO backend at
   * all. So the failure a user sees for a backend they explicitly picked, that
   * the app told them was viable, is a shell command.
   *
   * Asserted through the real `serve()` rather than by grepping for the
   * literal: what matters is that the returned status carries the backend that
   * was asked for, which is false for both a missing branch AND a branch that
   * mislabels its own status.
   */
  const MODEL: CatalogModel = {
    name: 'org/Model',
    provider: 'org',
    parameterCount: '7B',
    quantization: 'Q4_K_M',
    ggufSources: [{ repo: 'org/Model-GGUF', provider: 'hf' }],
  };

  /** A host on which all four backends are viable at once. */
  const makeService = (): CookbookServeService => {
    const serveManager = {
      detectAvailability: async () => HOSTS.everything.available,
      detectBackend: async () => 'none' as const,
      start: async () => 51500,
      startVllm: async () => 51600,
      pullOllama: async (): Promise<void> => undefined,
      stop: async (): Promise<void> => undefined,
      setBackendBinary: () => true,
    } as unknown as LocalServeManager;

    const downloadManager = {
      isDownloaded: () => true,
      download: async () => ({ modelId: MODEL.name, filePath: '/cache/org_Model.gguf', cached: true, bytesWritten: 0 }),
      cancel: () => false,
    } as unknown as ModelDownloadManager;

    return new CookbookServeService({
      downloadManager,
      serveManager,
      getCatalog: () => [MODEL],
      getRepo: () => null,
      getGgufDir: () => '/cache/gguf',
      getHardware: async () => ({
        totalRamGb: 64,
        availableRamGb: 32,
        cpuCores: 16,
        cpuName: 'Test CPU',
        hasGpu: true,
        gpuName: 'Test GPU',
        gpuVramGb: 24,
        gpuCount: 1,
        gpus: [{ index: 0, name: 'Test GPU', vramGb: 24 }],
        backend: 'cuda',
        platform: 'linux',
        gpuError: null,
      }),
      // LM Studio is holding the model, so the lm-studio branch can complete.
      // Injected, never fetched: a network call here would make the test's
      // answer depend on whether the developer happens to have LM Studio open.
      probeLmStudio: async () => ({
        serving: true,
        models: [{ id: 'org/model', type: 'llm', state: 'not-loaded' }],
        port: 1234,
      }),
      probeOllama: async () => ({ ok: true, models: [] }) as never,
      arch: 'x64',
    });
  };

  it('dispatches each one to its own path, never to the degraded fallback', async () => {
    // A fresh service per backend, so no serve can be explained by the previous
    // one's state; they are independent, so they run together.
    const results = await Promise.all(
      SERVEABLE_COOKBOOK_BACKENDS.map(async (backend) => ({
        backend,
        status: await makeService().serve(MODEL.name, backend),
      }))
    );
    for (const { backend, status } of results) {
      expect(status.backend, `serve(override=${backend}) fell through`).toBe(backend);
      expect(status.state, `serve(override=${backend})`).not.toBe('needs_backend');
    }
  });
});

describe('the IPC validator is built from the union, not re-listed beside it', () => {
  /**
   * A `ReadonlySet<CookbookBackend>` is NOT exhaustive-checked, so a
   * hand-written literal list here type-checks while silently rejecting a
   * backend the rest of the app offers - and `safeBackend` turns a rejected
   * value into `undefined`, which `serve()` reads as "no override", so the
   * user's explicit pick becomes the hardware default with no error anywhere.
   * The fix is construction, not a matching test; this asserts the
   * construction has not been reverted to a copy.
   */
  const BRIDGE = readFileSync(join(process.cwd(), 'src/process/bridge/engine/cookbookBridge.ts'), 'utf-8');

  it('derives VALID_BACKENDS from COOKBOOK_BACKENDS', () => {
    expect(BRIDGE).toContain('new Set<CookbookBackend>(COOKBOOK_BACKENDS)');
  });

  it('names no backend of its own', () => {
    // `'none'` is exempt: the locate-backend reply reports it as a literal
    // result value, which is not a copy of the list.
    for (const backend of SERVEABLE_COOKBOOK_BACKENDS) {
      expect(BRIDGE, `cookbookBridge.ts re-lists '${backend}'`).not.toContain(`'${backend}'`);
    }
  });
});
