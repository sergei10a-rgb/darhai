/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compare service (Odysseus #6).
 *
 * Runs one prompt through several user-selected models concurrently (bounded)
 * and returns their outputs side by side. Each run:
 *
 *   1. Resolves the renderer's non-secret `{ providerId, modelId }` ref to the
 *      legacy merged `IProvider` (the model-registry mirror kept in `model.config`).
 *   2. Builds a `TProviderWithModel` seed keyed on the registry `providerId`,
 *      then `hydrateModelForSpawn` merges the decrypted key in the main process
 *      at dispatch (the key never crossed IPC and is never persisted here).
 *   3. Derives a `PickedModel { provider, modelId }` from the hydrated model and
 *      makes a single stateless call via `oneShotComplete`.
 *
 * Per-run isolation: one model failing (bad key, timeout, unreachable endpoint)
 * never rejects the batch - each run reports its own `{ ok, error }`.
 */

import { getMergedModelProviders } from '@process/bridge/modelBridge';
import { hydrateModelForSpawn } from '@process/providers/ipc/modelRegistryIpc';
import { oneShotComplete, type PickedModel } from '@process/services/completion/oneShot';
import { DEFAULT_ACCOUNT_ID } from '@/common/config/account';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import type { CompareModelRef, CompareRequest, CompareResult, CompareRunResult } from '@/common/types/compare';

/** How many models to call at once. Keeps host / network pressure bounded. */
const MAX_CONCURRENCY = 4;
/** Generous single-response cap so answers are comparable, not truncated to a tweet. */
const DEFAULT_MAX_TOKENS = 800;
/** Per-run wall-clock ceiling - a stuck endpoint must not hang the whole compare. */
const RUN_TIMEOUT_MS = 60_000;

/**
 * Resolve a non-secret model ref to a callable {@link PickedModel}. Finds the
 * merged provider that owns `modelId` (preferring an exact registry-id match),
 * seeds a `TProviderWithModel` keyed on the registry `providerId` so hydration
 * resolves the right encrypted credential, then derives the `PickedModel` the
 * one-shot caller expects. Returns `null` when the ref cannot be resolved to a
 * known provider (the run reports `model-not-found`).
 */
async function resolvePickedModel(ref: CompareModelRef, providers: IProvider[]): Promise<PickedModel | null> {
  const owns = (p: IProvider): boolean => Array.isArray(p.model) && p.model.includes(ref.modelId);
  // Prefer the provider whose id matches the ref; otherwise any provider that
  // exposes this model id (model ids are unique enough that first-match is safe).
  const merged = providers.find((p) => p.id === ref.providerId && owns(p)) ?? providers.find(owns);
  if (!merged) return null;

  // Strip the legacy `model[]` array; a TProviderWithModel carries a single
  // `useModel` instead. Key `id` on the registry providerId so hydration finds
  // the encrypted credential row (the merged mirror row uses a uuid id).
  const { model: _models, ...rest } = merged;
  const seed: TProviderWithModel = {
    ...rest,
    id: ref.providerId,
    useModel: ref.modelId,
    accountId: DEFAULT_ACCOUNT_ID,
  };

  // Resolve the decrypted key in main at dispatch. A null resolution (legacy
  // row not in the registry) leaves the seed's own mirror key intact.
  const hydrated = await hydrateModelForSpawn(seed);

  // Derive the PickedModel: reconstitute an IProvider by putting the single
  // chosen model back into a `model[]`, and route on the hydrated model id. The
  // spread carries platform / baseUrl / apiKey the one-shot endpoint resolver
  // needs; the extra `useModel` / `accountId` fields are harmless.
  const provider: IProvider = { ...hydrated, model: [hydrated.useModel] };
  return { provider, modelId: hydrated.useModel };
}

/** Human label for a run - the renderer's own label wins, else `providerId / modelId`. */
function labelFor(ref: CompareModelRef): string {
  if (ref.label && ref.label.trim().length > 0) return ref.label.trim();
  return `${ref.providerId} / ${ref.modelId}`;
}

/**
 * Run a single model. Never throws: every failure (unresolvable ref, no usable
 * model, endpoint error, timeout) is captured as `{ ok: false, error }` so the
 * batch stays isolated.
 */
async function runOne(ref: CompareModelRef, prompt: string, providers: IProvider[]): Promise<CompareRunResult> {
  const label = labelFor(ref);
  const startedAt = Date.now();
  try {
    const picked = await resolvePickedModel(ref, providers);
    if (!picked) {
      return { modelRef: ref, label, ok: false, text: '', error: 'model-not-found', ms: Date.now() - startedAt };
    }
    const text = await oneShotComplete(prompt, {
      model: picked,
      maxTokens: DEFAULT_MAX_TOKENS,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    return { modelRef: ref, label, ok: true, text, ms: Date.now() - startedAt };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'request failed';
    return { modelRef: ref, label, ok: false, text: '', error: message, ms: Date.now() - startedAt };
  }
}

/**
 * Run `refs` through a bounded worker pool, preserving input order in the output.
 * A shared cursor hands each idle worker the next ref.
 */
async function runBounded(
  refs: CompareModelRef[],
  prompt: string,
  providers: IProvider[]
): Promise<CompareRunResult[]> {
  const out: CompareRunResult[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= refs.length) return;
      // Sequential by design: each worker pulls the next ref only after its
      // current run settles - that IS the concurrency bound (MAX_CONCURRENCY
      // workers run in parallel across the outer Promise.all).
      // eslint-disable-next-line no-await-in-loop
      out[index] = await runOne(refs[index], prompt, providers);
    }
  };
  const workerCount = Math.min(MAX_CONCURRENCY, refs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}

/**
 * Run the same prompt through every selected model and return the outputs side
 * by side. The caller (compareBridge) has already validated / clamped the input.
 */
export async function runCompare(request: CompareRequest): Promise<CompareResult> {
  const { prompt, modelRefs } = request;
  if (modelRefs.length === 0) {
    return { runs: [], noUsableModel: true };
  }
  // One provider snapshot for the whole batch - avoids N reads of `model.config`.
  const providers = await getMergedModelProviders().catch(() => [] as IProvider[]);
  const runs = await runBounded(modelRefs, prompt, providers);
  // "No usable model" = not a single ref resolved to a callable provider.
  const noUsableModel = runs.every(
    (run) => !run.ok && (run.error === 'model-not-found' || run.error === 'no-usable-model')
  );
  return { runs, noUsableModel };
}
