/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the "Fusion" feature (OmniRoute idea).
 *
 * `fusion.run` fans a prompt out across a panel of models and then has a judge
 * model synthesize the best answer. It fans out (like Compare) AND makes an
 * extra judge call, so it spends even more tokens - it is remote-denied (see
 * bridgeAllowlist REMOTE_DENIED_KEYS): a paired-device WebSocket caller must
 * never drive it. The local renderer contract is still untrusted input crossing
 * a process boundary, so every field is validated / clamped here (mirroring
 * compareBridge) before it reaches the service.
 */

import { ipcBridge } from '@/common';
import { runFusion } from '@process/services/compare/fusionService';
import type { CompareModelRef, FusionRequest, FusionResult } from '@/common/types/compare';

/** Hard cap on the prompt length (chars). */
const MAX_PROMPT_LEN = 20_000;
/** Max models in the panel - keeps the fan-out (and token spend) bounded. */
const MAX_MODELS = 6;
/** Cap on any single id / label string. */
const MAX_STRING_LEN = 256;

/** A trimmed string capped at {@link MAX_STRING_LEN}, or `''`. */
function safeString(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_STRING_LEN) : '';
}

/** Validate + clamp one renderer-supplied model ref; `null` when unusable. */
function safeModelRef(value: unknown): CompareModelRef | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<CompareModelRef>;
  const providerId = safeString(raw.providerId);
  const modelId = safeString(raw.modelId);
  if (!providerId || !modelId) return null;
  const ref: CompareModelRef = { providerId, modelId };
  const label = safeString(raw.label);
  if (label) ref.label = label;
  return ref;
}

/** Validate + clamp the full request: trim prompt, drop malformed/dup refs, cap count. */
function toRequest(params: unknown): FusionRequest {
  const raw = (params && typeof params === 'object' ? params : {}) as Partial<FusionRequest>;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.slice(0, MAX_PROMPT_LEN) : '';
  const rawRefs = Array.isArray(raw.modelRefs) ? raw.modelRefs : [];

  const seen = new Set<string>();
  const modelRefs: CompareModelRef[] = [];
  for (const candidate of rawRefs) {
    if (modelRefs.length >= MAX_MODELS) break;
    const ref = safeModelRef(candidate);
    if (!ref) continue;
    const dedupKey = `${ref.providerId} ${ref.modelId}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    modelRefs.push(ref);
  }

  return { prompt, modelRefs };
}

/** Initialize the fusion IPC bridge handler. */
export function initFusionBridge(): void {
  ipcBridge.fusion.run.provider(async (params): Promise<FusionResult> => {
    const request = toRequest(params);
    if (request.prompt.trim().length === 0 || request.modelRefs.length === 0) {
      return { runs: [], synthesis: '', judgeLabel: '', noUsableModel: true };
    }
    return runFusion(request);
  });
}
