/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the Compare service (Odysseus #6). The three collaborators
 * (`getMergedModelProviders`, `hydrateModelForSpawn`, `oneShotComplete`) are
 * mocked so we exercise fan-out, per-run error isolation, the hydrate ->
 * PickedModel derivation, and no-usable-model handling in pure isolation - with
 * no Electron / DB / network dependency.
 *
 * Lives in tests/unit/ (not co-located next to the service) because vitest.config
 * only includes `tests/unit/**` for the node project; a `src/**` test would never
 * run under `bun run test`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMergedModelProviders: vi.fn(),
  hydrateModelForSpawn: vi.fn(),
  oneShotComplete: vi.fn(),
}));

vi.mock('@process/bridge/model/modelBridge', () => ({ getMergedModelProviders: mocks.getMergedModelProviders }));
vi.mock('@process/providers/ipc/modelRegistryIpc', () => ({ hydrateModelForSpawn: mocks.hydrateModelForSpawn }));
vi.mock('@process/services/completion/oneShot', () => ({ oneShotComplete: mocks.oneShotComplete }));

import { runCompare } from '@process/services/compare/compareService';

const PROVIDERS = [
  {
    id: 'anthropic',
    platform: 'anthropic',
    name: 'Anthropic',
    baseUrl: '',
    apiKey: 'sk-ant-x',
    model: ['claude-3-5-sonnet'],
  },
  { id: 'openai', platform: 'openai', name: 'OpenAI', baseUrl: '', apiKey: 'sk-o', model: ['gpt-4o'] },
];

beforeEach(() => {
  mocks.getMergedModelProviders.mockReset();
  mocks.hydrateModelForSpawn.mockReset();
  mocks.oneShotComplete.mockReset();
  // Default: hydration is identity (a legacy row not in the registry keeps creds).
  mocks.hydrateModelForSpawn.mockImplementation(async (model: unknown) => model);
});

describe('runCompare', () => {
  it('fans the prompt out across every selected model, preserving order', async () => {
    mocks.getMergedModelProviders.mockResolvedValue(PROVIDERS);
    mocks.oneShotComplete.mockImplementation(async (_prompt: string, opts: { model: { modelId: string } }) => {
      return `reply:${opts.model.modelId}`;
    });

    const result = await runCompare({
      prompt: 'Explain recursion',
      blind: false,
      modelRefs: [
        { providerId: 'anthropic', modelId: 'claude-3-5-sonnet', label: 'Claude' },
        { providerId: 'openai', modelId: 'gpt-4o', label: 'GPT-4o' },
      ],
    });

    expect(mocks.oneShotComplete).toHaveBeenCalledTimes(2);
    expect(result.noUsableModel).toBe(false);
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]).toMatchObject({ ok: true, label: 'Claude', text: 'reply:claude-3-5-sonnet' });
    expect(result.runs[1]).toMatchObject({ ok: true, label: 'GPT-4o', text: 'reply:gpt-4o' });
    expect(typeof result.runs[0].ms).toBe('number');
  });

  it('derives the PickedModel from the hydrated model (id -> providerId, useModel -> modelId)', async () => {
    mocks.getMergedModelProviders.mockResolvedValue(PROVIDERS);
    mocks.oneShotComplete.mockResolvedValue('ok');

    await runCompare({
      prompt: 'hi',
      blind: false,
      modelRefs: [{ providerId: 'anthropic', modelId: 'claude-3-5-sonnet' }],
    });

    // The seed handed to hydration is keyed on the registry providerId + modelId.
    const hydrateArg = mocks.hydrateModelForSpawn.mock.calls[0][0];
    expect(hydrateArg).toMatchObject({ id: 'anthropic', useModel: 'claude-3-5-sonnet', platform: 'anthropic' });
    expect(hydrateArg.model).toBeUndefined();

    // The PickedModel passed to oneShotComplete carries the reconstituted provider.
    const [, opts] = mocks.oneShotComplete.mock.calls[0];
    expect(opts.model.modelId).toBe('claude-3-5-sonnet');
    expect(opts.model.provider.platform).toBe('anthropic');
    expect(opts.model.provider.apiKey).toBe('sk-ant-x');
    expect(opts.model.provider.model).toEqual(['claude-3-5-sonnet']);
  });

  it('isolates a failing run - one model erroring never rejects the batch', async () => {
    mocks.getMergedModelProviders.mockResolvedValue(PROVIDERS);
    mocks.oneShotComplete.mockImplementation(async (_prompt: string, opts: { model: { modelId: string } }) => {
      if (opts.model.modelId === 'gpt-4o') throw new Error('401: unauthorized');
      return 'ok-claude';
    });

    const result = await runCompare({
      prompt: 'compare me',
      blind: false,
      modelRefs: [
        { providerId: 'anthropic', modelId: 'claude-3-5-sonnet' },
        { providerId: 'openai', modelId: 'gpt-4o' },
      ],
    });

    expect(result.noUsableModel).toBe(false);
    expect(result.runs[0]).toMatchObject({ ok: true, text: 'ok-claude' });
    expect(result.runs[1]).toMatchObject({ ok: false, text: '', error: '401: unauthorized' });
  });

  it('reports model-not-found when a ref resolves to no provider', async () => {
    mocks.getMergedModelProviders.mockResolvedValue(PROVIDERS);
    mocks.oneShotComplete.mockResolvedValue('unused');

    const result = await runCompare({
      prompt: 'x',
      blind: false,
      modelRefs: [{ providerId: 'ghost', modelId: 'not-a-real-model' }],
    });

    expect(mocks.oneShotComplete).not.toHaveBeenCalled();
    expect(result.runs[0]).toMatchObject({ ok: false, error: 'model-not-found' });
    expect(result.noUsableModel).toBe(true);
  });

  it('flags noUsableModel when there are no configured providers at all', async () => {
    mocks.getMergedModelProviders.mockResolvedValue([]);

    const result = await runCompare({
      prompt: 'x',
      blind: false,
      modelRefs: [{ providerId: 'anthropic', modelId: 'claude-3-5-sonnet' }],
    });

    expect(result.noUsableModel).toBe(true);
    expect(result.runs[0].ok).toBe(false);
  });

  it('returns an empty, no-usable-model result for zero refs', async () => {
    const result = await runCompare({ prompt: 'x', blind: false, modelRefs: [] });
    expect(result).toEqual({ runs: [], noUsableModel: true });
    expect(mocks.getMergedModelProviders).not.toHaveBeenCalled();
  });

  it('surfaces oneShotComplete "no-usable-model" as a per-run error and flags noUsableModel', async () => {
    mocks.getMergedModelProviders.mockResolvedValue(PROVIDERS);
    mocks.oneShotComplete.mockRejectedValue(new Error('no-usable-model'));

    const result = await runCompare({
      prompt: 'x',
      blind: false,
      modelRefs: [{ providerId: 'anthropic', modelId: 'claude-3-5-sonnet' }],
    });

    expect(result.runs[0]).toMatchObject({ ok: false, error: 'no-usable-model' });
    expect(result.noUsableModel).toBe(true);
  });
});
