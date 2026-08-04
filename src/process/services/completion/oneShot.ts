/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { getMergedModelProviders } from '@process/bridge/modelBridge';
import { isExactMirrorRowFor } from '@process/providers/legacyModelConfigBridge';
import { OMNIROUTE_GATEWAY_PROVIDER_ID } from '@/common/types/omnirouteGateway';
import type { IProvider } from '@/common/config/storage';
import type { CompressionMode } from '@/common/types/compression';
import { compress } from '@process/services/compression';
import { googleAuthGeminiComplete, isGoogleAuthGeminiAvailable } from './geminiOAuth';
import { getCompressionMode } from './compressionMode';
import { getRoutingStrategy } from './routingStrategy';
import { resilientFetch } from './resilientFetch';
import { isProviderCircuitOpen, isModelLockedOut } from '@process/services/resilience';
import { pickModel, usageCounter, type RoundRobinCursor, type RoutingCandidate } from '@process/services/routing';
import { getModelPricing, type IModelPricing } from '@process/services/cost/ModelPricing';
import { readJsonBody } from './readJsonBody';

/**
 * A minimal one-shot LLM completion for cheap background tasks (e.g. the project
 * knowledge one-liner summary). It deliberately does NOT go through the
 * conversation engine: it picks the cheapest fast model the user already has a
 * key for and makes a single stateless call.
 *
 * Model selection is by name heuristic (haiku / mini / flash / nano / lite …)
 * rather than the provider-keyed classifier, so it works regardless of how the
 * provider labels itself. Routing is by endpoint host, not platform label, so a
 * Claude model served through an OpenAI-compatible proxy is still hit correctly.
 */

/** Name fragments that indicate a small/cheap/fast model, best first. */
const FAST_HINTS = [
  /haiku/i,
  /flash-lite/i,
  /flash/i,
  /gpt-4o-mini/i,
  /gpt-5-mini/i,
  /[-_]mini\b/i,
  /[-_]nano\b/i,
  /[-_]lite\b/i,
  /[-_]small\b/i,
  /\b8b\b/i,
  /turbo/i,
];

export type PickedModel = { provider: IProvider; modelId: string };

type Endpoint = { flavor: 'anthropic' | 'gemini' | 'openai'; base: string };

/**
 * Resolve how to call a provider, by platform (the authoritative signal) with
 * canonical endpoint defaults - many providers store an empty baseUrl and rely
 * on the platform default. Returns null when we cannot reliably reach it (a
 * generic openai-compatible provider with no baseUrl has no known endpoint), so
 * such providers are simply skipped rather than mis-called.
 */
const resolveEndpoint = (p: IProvider): Endpoint | null => {
  const platform = (p.platform || '').toLowerCase();
  const baseUrl = (p.baseUrl || '').trim();
  if (platform.includes('anthropic') || platform.includes('claude') || p.apiKey?.startsWith('sk-ant-')) {
    return { flavor: 'anthropic', base: baseUrl || 'https://api.anthropic.com' };
  }
  if (platform.includes('gemini') || platform.includes('google') || baseUrl.includes('generativelanguage')) {
    return { flavor: 'gemini', base: baseUrl || 'https://generativelanguage.googleapis.com' };
  }
  if (platform === 'openai') {
    return { flavor: 'openai', base: baseUrl || 'https://api.openai.com/v1' };
  }
  // openai-compatible (groq, byok proxies, etc.): only reachable with an explicit baseUrl.
  if (baseUrl) return { flavor: 'openai', base: baseUrl };
  return null;
};

const usableModels = (providers: IProvider[]): PickedModel[] => {
  const out: PickedModel[] = [];
  for (const p of providers) {
    if (p.enabled === false) continue;
    // OmniRoute gateway (Phase 7b), owner condition 3: the external relay is
    // EXPLICIT-selection-only. Every automatic pick (pickCheapestFastModel /
    // pickBestModel / all routing strategies) enumerates through this
    // function, so skipping the gateway here guarantees no background
    // one-shot call (title-gen, research, triage, ...) ever routes a prompt
    // through the relay silently. Only an explicit `opts.model` or the user's
    // per-conversation model selection - both of which bypass this
    // enumeration - can use it.
    if (isExactMirrorRowFor(p, OMNIROUTE_GATEWAY_PROVIDER_ID)) continue;
    if (!p.apiKey || !p.apiKey.trim()) continue; // needs a key to call
    if (!resolveEndpoint(p)) continue; // no reachable endpoint - skip
    const models = Array.isArray(p.model) ? p.model : [];
    for (const modelId of models) {
      if (p.modelEnabled && p.modelEnabled[modelId] === false) continue;
      // Resilience filter (OmniRoute idea, native): skip a candidate whose provider
      // circuit is open or whose (provider, model) is under a 429 lockout. Because
      // the pickers then fall through to the next candidate, cross-provider
      // auto-fallback happens for free with no extra routing code.
      if (isProviderCircuitOpen(p.id) || isModelLockedOut(p.id, modelId)) continue;
      out.push({ provider: p, modelId });
    }
  }
  return out;
};

/**
 * Name-heuristic rank (lower = preferred fast/cheap model). Exported so the
 * routing dispatcher's `priority`/`auto` strategy reproduces this exact ordering
 * and `least-used` can break ties by it - the strategies never re-derive it.
 */
export const fastRank = (modelId: string): number => {
  for (let i = 0; i < FAST_HINTS.length; i++) {
    if (FAST_HINTS[i].test(modelId)) return i;
  }
  return FAST_HINTS.length; // not a known-fast model - lowest preference
};

/** Name fragments that indicate a flagship / most-capable model, best first. */
const BEST_HINTS = [
  /opus/i,
  /gpt-5\.\d/i,
  /gpt-5/i,
  /sonnet/i,
  /gemini-[\d.]*-?pro/i,
  /[-_]pro\b/i,
  /gpt-4\.1/i,
  /gpt-4o(?!-mini)/i,
  /[-_]large\b/i,
];

const bestRank = (modelId: string): number => {
  for (let i = 0; i < BEST_HINTS.length; i++) {
    if (BEST_HINTS[i].test(modelId)) return i;
  }
  return BEST_HINTS.length; // not a known-flagship model
};

/** Pick the cheapest fast model the user has a usable key for, or null. */
export async function pickCheapestFastModel(): Promise<PickedModel | null> {
  const providers = await getMergedModelProviders();
  const candidates = usableModels(providers);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => fastRank(a.modelId) - fastRank(b.modelId));
  return candidates[0];
}

/**
 * Pick the most capable model the user has a usable key for (for high-stakes,
 * rarely-run drafting like the knowledge wizard). Prefers known flagships by
 * name; when none match, de-prioritizes the obviously-cheap/fast models so a
 * more capable default wins.
 */
export async function pickBestModel(): Promise<PickedModel | null> {
  const providers = await getMergedModelProviders();
  const candidates = usableModels(providers);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const rb = bestRank(b.modelId);
    const ra = bestRank(a.modelId);
    if (ra !== rb) return ra - rb; // known flagship first
    return fastRank(b.modelId) - fastRank(a.modelId); // tie: prefer the less-cheap (more capable) one
  });
  return candidates[0];
}

/** True if any configured model can be called (used to enable the UI affordance). */
export async function hasUsableModel(): Promise<boolean> {
  if ((await pickCheapestFastModel()) !== null) return true;
  // Google-auth users have no keyed model but can still complete via OAuth Gemini.
  return isGoogleAuthGeminiAvailable();
}

// ─── Routing seam (OmniRoute idea, native) ─────────────────────────────────────
// A configurable strategy chooses which usable model is picked when the caller
// does not pin one. Default `auto` maps to `pickCheapestFastModel` unchanged, so
// with no config set the selection is byte-identical to before routing existed.

/** One million - the token base the models.dev cost is denominated in (USD/M). */
const TOKENS_PER_MILLION = 1_000_000;

/** Process-lifetime cursor so the `round-robin` strategy advances across calls. */
const routingCursor: RoundRobinCursor = { value: 0 };

/**
 * Look up a model's per-million pricing from the existing pricing authority
 * (`ModelPricing`, backed by the bundled models.dev snapshot). Reuses the app's
 * cost data - never fetches pricing anew. Returns `undefined` when the model is
 * not priced, so the cost strategy sorts it last rather than treating it as free.
 */
function priceOf(pricing: IModelPricing, modelId: string): RoutingCandidate['pricing'] {
  const inUSDPerMillion = pricing.priceTokens(modelId, { input: TOKENS_PER_MILLION, output: 0 });
  const outUSDPerMillion = pricing.priceTokens(modelId, { input: 0, output: TOKENS_PER_MILLION });
  if (inUSDPerMillion === undefined && outUSDPerMillion === undefined) return undefined;
  return { inUSDPerMillion, outUSDPerMillion };
}

/**
 * Resolve the model to complete with when the caller did not pin `opts.model`.
 * `auto` (the default) is the pre-routing path verbatim; any other strategy runs
 * the native dispatcher over the same `usableModels` enumeration. Either way the
 * final selection is recorded so `least-used` / `round-robin` have live history.
 */
async function resolvePickedModel(): Promise<PickedModel | null> {
  const strategy = await getRoutingStrategy();

  if (strategy === 'auto') {
    const picked = await pickCheapestFastModel();
    if (picked) usageCounter.recordUse(picked.provider.id, picked.modelId);
    return picked;
  }

  const providers = await getMergedModelProviders();
  const models = usableModels(providers);
  if (models.length === 0) return null;

  // Pricing is only needed by the cost strategy; other strategies skip the
  // snapshot read entirely so the pick path stays lean.
  const pricing = strategy === 'cost-optimized' ? getModelPricing() : null;
  const candidates: RoutingCandidate[] = models.map((m) => {
    const p = pricing ? priceOf(pricing, m.modelId) : undefined;
    return p ? { provider: m.provider, modelId: m.modelId, pricing: p } : { provider: m.provider, modelId: m.modelId };
  });

  const picked = pickModel(strategy, candidates, {
    rank: fastRank,
    loadOf: (c) => usageCounter.getCount(c.provider.id, c.modelId),
    roundRobinCursor: routingCursor,
  });
  if (picked) usageCounter.recordUse(picked.provider.id, picked.modelId);
  return picked;
}

const joinUrl = (base: string, suffix: string): string => `${base.replace(/\/+$/, '')}${suffix}`;

/**
 * Apply token compression to the prompt before send. Defensive by design: `off`
 * short-circuits, and any throw or empty/whitespace-only result falls back to
 * the original prompt so compression can never break a completion.
 */
function maybeCompress(prompt: string, mode: CompressionMode): string {
  if (mode === 'off') return prompt;
  try {
    const { text } = compress(prompt, mode);
    return text.trim().length > 0 ? text : prompt;
  } catch {
    return prompt;
  }
}

/**
 * Make a single completion call. Routes by endpoint host so a Claude/Gemini
 * model served via an OpenAI-compatible proxy is still called the right way.
 */
export async function oneShotComplete(
  prompt: string,
  opts?: { maxTokens?: number; model?: PickedModel; timeoutMs?: number; compressionMode?: CompressionMode }
): Promise<string> {
  const picked = opts?.model ?? (await resolvePickedModel());
  // Token compression seam (OmniRoute idea, native): shrink the prompt before
  // send so every one-shot caller (Compare, Deep Research, title-gen, project-
  // knowledge, onboarding, ...) benefits. Per-call override wins; otherwise the
  // configured mode is used, defaulting to the lossless `lite`.
  const mode = opts?.compressionMode ?? (await getCompressionMode());
  const effectivePrompt = maybeCompress(prompt, mode);
  if (!picked) {
    // No keyed model. Fall back to Google-auth Gemini for users who connected via
    // "Continue with Google" (the primary onboarding path): they have no API key,
    // so the key-based provider scan never surfaces their Gemini models.
    if (isGoogleAuthGeminiAvailable()) {
      return googleAuthGeminiComplete(effectivePrompt, { maxTokens: opts?.maxTokens, timeoutMs: opts?.timeoutMs });
    }
    throw new Error('no-usable-model');
  }
  const { provider, modelId } = picked;
  const endpoint = resolveEndpoint(provider);
  if (!endpoint) throw new Error('no-usable-model');
  const maxTokens = opts?.maxTokens ?? 160;
  const timeoutMs = opts?.timeoutMs;
  const { flavor, base } = endpoint;

  if (flavor === 'anthropic') {
    const res = await resilientFetch({
      provider,
      modelId,
      flavor: 'anthropic',
      timeoutMs,
      buildRequest: (apiKey) => ({
        url: joinUrl(base, '/v1/messages'),
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'User-Agent': 'Wayland/1.0',
          },
          body: JSON.stringify({
            model: modelId,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: effectivePrompt }],
          }),
        },
      }),
    });
    const data = await readJsonBody<{ content?: Array<{ text?: string }>; error?: { message?: string } }>(
      res,
      'anthropic'
    );
    if (!res.ok) throw new Error(`${res.status}: ${data.error?.message || 'request failed'}`);
    return (data.content?.[0]?.text || '').trim();
  }

  if (flavor === 'gemini') {
    const res = await resilientFetch({
      provider,
      modelId,
      flavor: 'gemini',
      timeoutMs,
      buildRequest: (apiKey) => ({
        url: joinUrl(base, `/v1beta/models/${modelId}:generateContent?key=${apiKey}`),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Wayland/1.0' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: effectivePrompt }] }],
            generationConfig: { maxOutputTokens: maxTokens },
          }),
        },
      }),
    });
    const data = await readJsonBody<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
    }>(res, 'gemini');
    if (!res.ok) throw new Error(`${res.status}: ${data.error?.message || 'request failed'}`);
    return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  }

  // OpenAI-compatible
  const res = await resilientFetch({
    provider,
    modelId,
    flavor: 'openai',
    timeoutMs,
    buildRequest: (apiKey) => ({
      url: joinUrl(base, '/chat/completions'),
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'Wayland/1.0',
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: effectivePrompt }],
        }),
      },
    }),
  });
  const data = await readJsonBody<{
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  }>(res, 'openai-compatible');
  if (!res.ok) throw new Error(`${res.status}: ${data.error?.message || 'request failed'}`);
  return (data.choices?.[0]?.message?.content || '').trim();
}
