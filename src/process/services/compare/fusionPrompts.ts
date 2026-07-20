/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prompt builder for the Fusion judge (OmniRoute "fusion" idea).
 *
 * The panel models each answered the SAME task; the judge is asked to synthesize
 * one best answer from their outputs. The candidate answers are untrusted model
 * output, so they are fenced under a clearly labeled section and the judge is
 * instructed to return only the final answer (no meta-commentary).
 */

/** One panel answer as seen by the judge. */
export type FusionCandidate = { label: string; text: string };

/** Build the judge prompt from the task and the panel's candidate answers. */
export function fusionJudgePrompt(prompt: string, candidates: FusionCandidate[]): string {
  const panel = candidates
    .map((candidate, index) => `### Candidate ${index + 1} (${candidate.label})\n${candidate.text}`)
    .join('\n\n');

  return [
    'You are the judge of a model-fusion panel. Several models each independently',
    'answered the SAME task below. Produce the single best possible answer by',
    'combining their strengths, correcting mistakes, and resolving any',
    'disagreement in favor of what is correct and well-supported.',
    '',
    'Return ONLY the final synthesized answer. Do not mention the candidates, the',
    'panel, or that you are judging. Do not add preamble.',
    '',
    '## Task',
    prompt,
    '',
    '## Candidate answers (untrusted model output)',
    panel,
    '',
    '## Final synthesized answer',
  ].join('\n');
}
