/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The context meter's denominator, and the ceiling compaction is keyed off.
 *
 * `MODEL_CONTEXT_LIMITS` used dotted keys (`claude-opus-4.5`) while the app
 * passes hyphenated catalog ids (`claude-opus-4-5`). No Claude id ever matched
 * exactly, so all of them fell through to the fuzzy `includes()` pass and landed
 * on the bare `claude-opus-4` / `claude-sonnet-4` prefixes. Two errors in
 * opposite directions came out of that: `claude-opus-4-8` (really 1M) reported
 * 200K, and `claude-sonnet-4-5` (really 200K) reported 1M.
 *
 * This is not a display-only bug. Under-reporting compacts a conversation long
 * before it needs to be; over-reporting lets a turn run past the real window and
 * fail. So the numbers are pinned here AND checked against the same snapshot the
 * app ships, because a hand-maintained table is exactly the thing that drifts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_LIMIT,
  getModelContextLimit,
  MODEL_CONTEXT_LIMITS,
} from '@/renderer/utils/model/modelContextLimits';

const M = 1_000_000;
const K200 = 200_000;

describe('getModelContextLimit - Claude windows', () => {
  it('gives Opus 4.6/4.7/4.8 their real 1M window', () => {
    // The reported failure: these resolved to 200K via the bare `claude-opus-4`
    // fallback, so the meter showed 200K for a 1M session.
    expect(getModelContextLimit('claude-opus-4-8')).toBe(M);
    expect(getModelContextLimit('claude-opus-4-7')).toBe(M);
    expect(getModelContextLimit('claude-opus-4-6')).toBe(M);
  });

  it('keeps Opus 4.0/4.1/4.5 at 200K', () => {
    // "All Opus 4.x is 1M" is wrong - only 4.6 and up.
    expect(getModelContextLimit('claude-opus-4-5')).toBe(K200);
    expect(getModelContextLimit('claude-opus-4-1')).toBe(K200);
    expect(getModelContextLimit('claude-opus-4-20250514')).toBe(K200);
  });

  it('stops over-reporting Sonnet 4 and 4.5 as 1M', () => {
    // The opposite-direction error: these are 200K models that read as 1M, so a
    // turn could be allowed to run well past the real window.
    expect(getModelContextLimit('claude-sonnet-4-5')).toBe(K200);
    expect(getModelContextLimit('claude-sonnet-4')).toBe(K200);
    expect(getModelContextLimit('claude-sonnet-4-6')).toBe(M);
  });

  it('resolves dated and cased ids through the fuzzy pass', () => {
    expect(getModelContextLimit('claude-opus-4-8-20260101')).toBe(M);
    expect(getModelContextLimit('Claude-Opus-4-8')).toBe(M);
    expect(getModelContextLimit('claude-haiku-4-5-20251001')).toBe(K200);
  });

  it('resolves legacy Claude 3 ids rather than falling to the 1M default', () => {
    expect(getModelContextLimit('claude-3-sonnet-20240229')).toBe(K200);
    expect(getModelContextLimit('claude-3-5-sonnet-20241022')).toBe(K200);
    expect(getModelContextLimit('claude-3-opus-20240229')).toBe(K200);
  });

  it('falls back to the default only for a genuinely unknown model', () => {
    expect(getModelContextLimit('some-local-mongolian-4b')).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(getModelContextLimit(undefined)).toBe(DEFAULT_CONTEXT_LIMIT);
  });
});

describe('MODEL_CONTEXT_LIMITS conformance with the shipped models.dev snapshot', () => {
  // Anthropic only: other vendors re-serve the same model id through gateways at
  // different windows, so an id alone is not enough to pin a number there. The
  // Anthropic ids are unambiguous, and they are where the bug was.
  const snapshot = JSON.parse(readFileSync(join(process.cwd(), 'resources/modelsdev-snapshot.json'), 'utf8')) as Record<
    string,
    { models?: Record<string, { limit?: { context?: number } }> }
  >;
  const anthropic = snapshot.anthropic?.models ?? {};

  it('has a snapshot to check against', () => {
    expect(Object.keys(anthropic).length).toBeGreaterThan(10);
  });

  it('agrees with the snapshot for every Claude id it names exactly', () => {
    const disagreements: string[] = [];

    for (const [key, tableLimit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
      if (!key.startsWith('claude-')) continue;
      const real = anthropic[key]?.limit?.context;
      // Bare family keys (`claude-opus-4`) are deliberate fuzzy fallbacks and are
      // not snapshot ids; skip anything the snapshot does not name.
      if (typeof real !== 'number') continue;
      if (real !== tableLimit) {
        disagreements.push(`${key}: table ${tableLimit} vs snapshot ${real}`);
      }
    }

    expect(disagreements).toEqual([]);
  });

  it('resolves every Claude id in the snapshot to that id’s real window', () => {
    // The end-to-end guard: not just "the table agrees" but "the lookup a caller
    // actually performs returns the right number", which is what the dotted keys
    // broke - the table looked plausible and every lookup still missed it.
    const wrong: string[] = [];

    for (const [modelId, model] of Object.entries(anthropic)) {
      const real = model.limit?.context;
      if (typeof real !== 'number') continue;
      const resolved = getModelContextLimit(modelId);
      if (resolved !== real) wrong.push(`${modelId}: resolved ${resolved} vs real ${real}`);
    }

    expect(wrong).toEqual([]);
  });
});
