/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Production wiring for the email triage service.
 *
 * The ONLY place the service is bound to concrete Darhai primitives:
 *   - `complete`   -> `oneShotComplete` with the cheapest fast model the user
 *                     already has a key for (the same background-LLM rail the
 *                     project-knowledge summary and Deep Research extractor use)
 *   - `modelName`  -> the id of that cheapest fast model, for provenance
 *
 * No new LLM client and no agent loop are introduced. Critically, NO send
 * primitive is wired in - the service composes read/LLM/persistence primitives
 * only, which is the structural half of the draft-only safety guarantee.
 */

import { oneShotComplete, pickCheapestFastModel } from '@process/services/completion/oneShot';
import { IpcEmailTriageEventEmitter } from './IpcEmailTriageEventEmitter';
import { SqliteEmailTriageRepository } from './SqliteEmailTriageRepository';
import { TriageService } from './TriageService';

/** Per-call wall-clock ceiling so a stuck endpoint cannot hang the inbound loop. */
const COMPLETE_TIMEOUT_MS = 60_000;

async function complete(prompt: string, maxTokens: number): Promise<string> {
  const model = await pickCheapestFastModel();
  return oneShotComplete(prompt, {
    model: model ?? undefined,
    maxTokens,
    timeoutMs: COMPLETE_TIMEOUT_MS,
  });
}

async function modelName(): Promise<string> {
  const model = await pickCheapestFastModel();
  return model?.modelId ?? '';
}

export const emailTriageRepository = new SqliteEmailTriageRepository();

export const emailTriageService = new TriageService(emailTriageRepository, new IpcEmailTriageEventEmitter(), {
  complete,
  modelName,
  now: () => Date.now(),
});
