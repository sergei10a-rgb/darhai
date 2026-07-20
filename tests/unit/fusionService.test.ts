/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompareResult, CompareRunResult } from '@/common/types/compare';

const runCompareMock = vi.fn<(...args: unknown[]) => Promise<CompareResult>>();
const pickBestModelMock = vi.fn<() => Promise<unknown>>();
const oneShotCompleteMock = vi.fn<(...args: unknown[]) => Promise<string>>();

vi.mock('@process/services/compare/compareService', () => ({
  runCompare: (...args: unknown[]) => runCompareMock(...args),
}));
vi.mock('@process/services/completion/oneShot', () => ({
  pickBestModel: () => pickBestModelMock(),
  oneShotComplete: (...args: unknown[]) => oneShotCompleteMock(...args),
}));

// Imported after the mocks are registered.
const { runFusion } = await import('@process/services/compare/fusionService');

function run(ok: boolean, label: string, text: string): CompareRunResult {
  return { modelRef: { providerId: 'p', modelId: label }, label, ok, text, ms: 1 };
}

const JUDGE = { provider: { id: 'anthropic', name: 'Anthropic' }, modelId: 'best-model' };

beforeEach(() => {
  runCompareMock.mockReset();
  pickBestModelMock.mockReset();
  oneShotCompleteMock.mockReset();
});

describe('runFusion', () => {
  it('returns noUsableModel when no refs are given (no panel, no judge)', async () => {
    const result = await runFusion({ prompt: 'q', modelRefs: [] });
    expect(result.noUsableModel).toBe(true);
    expect(result.synthesis).toBe('');
    expect(runCompareMock).not.toHaveBeenCalled();
    expect(oneShotCompleteMock).not.toHaveBeenCalled();
  });

  it('judges over ALL successful panel answers, tolerating a failed run', async () => {
    runCompareMock.mockResolvedValue({
      runs: [run(true, 'A', 'answer-A'), run(false, 'B', ''), run(true, 'C', 'answer-C')],
      noUsableModel: false,
    });
    pickBestModelMock.mockResolvedValue(JUDGE);
    oneShotCompleteMock.mockResolvedValue('synthesized');

    const result = await runFusion({ prompt: 'task', modelRefs: [{ providerId: 'p', modelId: 'A' }] });

    expect(result.synthesis).toBe('synthesized');
    expect(result.judgeLabel).toBe('Anthropic / best-model');
    expect(result.judgeError).toBeUndefined();
    // The judge prompt carries both successful answers but not the failed one.
    const judgePrompt = oneShotCompleteMock.mock.calls[0][0] as string;
    expect(judgePrompt).toContain('answer-A');
    expect(judgePrompt).toContain('answer-C');
    expect(judgePrompt).not.toContain('(B)');
    // The judge is called with the best model.
    expect(oneShotCompleteMock.mock.calls[0][1]).toMatchObject({ model: JUDGE });
    // Raw panel runs are preserved.
    expect(result.runs).toHaveLength(3);
  });

  it('skips the judge when no panel run succeeded', async () => {
    runCompareMock.mockResolvedValue({ runs: [run(false, 'A', '')], noUsableModel: false });
    const result = await runFusion({ prompt: 'q', modelRefs: [{ providerId: 'p', modelId: 'A' }] });
    expect(result.synthesis).toBe('');
    expect(pickBestModelMock).not.toHaveBeenCalled();
    expect(oneShotCompleteMock).not.toHaveBeenCalled();
    expect(result.runs).toHaveLength(1);
  });

  it('reports judgeError (keeping the panel) when no judge model is available', async () => {
    runCompareMock.mockResolvedValue({ runs: [run(true, 'A', 'answer-A')], noUsableModel: false });
    pickBestModelMock.mockResolvedValue(null);
    const result = await runFusion({ prompt: 'q', modelRefs: [{ providerId: 'p', modelId: 'A' }] });
    expect(result.judgeError).toBe('no-usable-judge');
    expect(result.synthesis).toBe('');
    expect(result.runs).toHaveLength(1);
  });

  it('reports judgeError (keeping the panel) when the judge call throws', async () => {
    runCompareMock.mockResolvedValue({ runs: [run(true, 'A', 'answer-A')], noUsableModel: false });
    pickBestModelMock.mockResolvedValue(JUDGE);
    oneShotCompleteMock.mockRejectedValue(new Error('judge boom'));
    const result = await runFusion({ prompt: 'q', modelRefs: [{ providerId: 'p', modelId: 'A' }] });
    expect(result.judgeError).toBe('judge boom');
    expect(result.synthesis).toBe('');
    expect(result.judgeLabel).toBe('Anthropic / best-model');
    expect(result.runs).toHaveLength(1);
  });
});
