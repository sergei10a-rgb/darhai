/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fusion service (OmniRoute "fusion" idea).
 *
 * Fan the same prompt out across a panel of models - REUSING Compare's bounded,
 * per-run-isolated fan-out ({@link runCompare}) - then have a judge model
 * synthesize the single best answer from the successful panel outputs. The judge
 * is auto-selected as the best available local model ({@link pickBestModel}).
 *
 * Reuse, not rebuild: the panel is Compare's exact fan-out; the judge is one
 * more stateless {@link oneShotComplete} call, mirroring Deep Research's
 * synthesize step. No new concurrency pool, no new provider resolution.
 *
 * Failure isolation: a failed panel run never blocks the judge (it judges the
 * survivors); a failed judge never loses the panel (it returns with `judgeError`
 * and the raw runs intact).
 */

import { oneShotComplete, pickBestModel } from '@process/services/completion/oneShot';
import { runCompare } from './compareService';
import { fusionJudgePrompt } from './fusionPrompts';
import type { FusionRequest, FusionResult } from '@/common/types/compare';

/** The judge synthesizes, so it gets more room than a single panel answer. */
const JUDGE_MAX_TOKENS = 1600;
/** Judge wall-clock ceiling - a stuck judge must not hang after the panel returned. */
const JUDGE_TIMEOUT_MS = 90_000;

/**
 * Run a fusion: panel fan-out via Compare, then a judge synthesis over the
 * successful answers. Never throws - every failure mode returns a shaped result.
 */
export async function runFusion(request: FusionRequest): Promise<FusionResult> {
  const { prompt, modelRefs } = request;
  if (modelRefs.length === 0) {
    return { runs: [], synthesis: '', judgeLabel: '', noUsableModel: true };
  }

  // Panel = Compare's exact bounded, isolated fan-out (blind is irrelevant here).
  const compareResult = await runCompare({ prompt, modelRefs, blind: false });
  const successful = compareResult.runs.filter((run) => run.ok && run.text.trim().length > 0);

  // Nothing usable came back - hand the panel outcome straight through.
  if (successful.length === 0) {
    return { runs: compareResult.runs, synthesis: '', judgeLabel: '', noUsableModel: compareResult.noUsableModel };
  }

  const judge = await pickBestModel();
  if (!judge) {
    return {
      runs: compareResult.runs,
      synthesis: '',
      judgeLabel: '',
      noUsableModel: false,
      judgeError: 'no-usable-judge',
    };
  }
  const judgeLabel = `${judge.provider.name || judge.provider.id} / ${judge.modelId}`;

  try {
    const synthesis = await oneShotComplete(
      fusionJudgePrompt(
        prompt,
        successful.map((run) => ({ label: run.label, text: run.text }))
      ),
      { model: judge, maxTokens: JUDGE_MAX_TOKENS, timeoutMs: JUDGE_TIMEOUT_MS }
    );
    return { runs: compareResult.runs, synthesis, judgeLabel, noUsableModel: false };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'judge request failed';
    return { runs: compareResult.runs, synthesis: '', judgeLabel, noUsableModel: false, judgeError: message };
  }
}
