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
  /**
   * Consensus across providers, not one vendor row.
   *
   * The first version of this check read only the `anthropic` entry, and a
   * snapshot refresh promptly showed why that is not enough: that row began
   * reporting Sonnet 4.5 at 1M, which is its BETA tier. 29 other providers say
   * 200K and 8 say 1M, and this app never sends the `anthropic-beta:
   * context-1m-*` header that unlocks the larger window - so 1M is a number we
   * cannot actually obtain, and believing it would push compaction past the real
   * ceiling and fail the turn.
   *
   * Majority across every provider serving the id is the honest reading: it
   * still catches real drift, and a single vendor's beta tier cannot move it.
   */
  const snapshot = JSON.parse(readFileSync(join(process.cwd(), 'resources/modelsdev-snapshot.json'), 'utf8')) as Record<
    string,
    { models?: Record<string, { limit?: { context?: number } }> }
  >;

  /** Window most providers serving `modelId` report, or undefined if unknown. */
  const consensusWindow = (modelId: string): number | undefined => {
    const votes = new Map<number, number>();
    for (const provider of Object.values(snapshot)) {
      for (const [id, model] of Object.entries(provider.models ?? {})) {
        // `us.anthropic.claude-opus-5`, `anthropic/claude-opus-5`, plain id.
        if (id !== modelId && !id.endsWith(`/${modelId}`) && !id.endsWith(`.${modelId}`)) continue;
        const context = model.limit?.context;
        if (typeof context === 'number') votes.set(context, (votes.get(context) ?? 0) + 1);
      }
    }
    if (votes.size === 0) return undefined;
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };

  const anthropic = snapshot.anthropic?.models ?? {};

  it('has a snapshot to check against', () => {
    expect(Object.keys(anthropic).length).toBeGreaterThan(10);
  });

  it('matches the cross-provider consensus for every Claude id it names', () => {
    const disagreements: string[] = [];

    for (const [key, tableLimit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
      if (!key.startsWith('claude-')) continue;
      const consensus = consensusWindow(key);
      // Bare family keys (`claude-opus-4`) are deliberate fuzzy fallbacks and no
      // provider serves them as ids; skip anything nobody names.
      if (consensus === undefined) continue;
      if (consensus !== tableLimit) {
        disagreements.push(`${key}: table ${tableLimit} vs consensus ${consensus}`);
      }
    }

    expect(disagreements).toEqual([]);
  });

  it('resolves every Claude id Anthropic itself serves to its consensus window', () => {
    // The end-to-end guard: not "the table agrees" but "the lookup a caller
    // actually performs returns the right number" - which is exactly what the
    // dotted keys broke. The table looked plausible and every lookup missed it.
    const wrong: string[] = [];

    for (const modelId of Object.keys(anthropic)) {
      const consensus = consensusWindow(modelId);
      if (consensus === undefined) continue;
      const resolved = getModelContextLimit(modelId);
      if (resolved !== consensus) wrong.push(`${modelId}: resolved ${resolved} vs consensus ${consensus}`);
    }

    expect(wrong).toEqual([]);
  });

  it('resolves every model Anthropic currently offers in the picker', () => {
    // The concrete list a user sees today, top-level and under "More models".
    // Anchoring on that rather than on the whole snapshot keeps this honest
    // about what people actually select.
    const offered: Array<[string, number]> = [
      ['claude-fable-5', M],
      ['claude-opus-5', M],
      ['claude-sonnet-5', M],
      ['claude-haiku-4-5', K200],
      ['claude-opus-4-8', M],
      ['claude-opus-4-7', M],
      ['claude-opus-4-6', M],
      ['claude-sonnet-4-6', M],
    ];

    const wrong = offered
      .filter(([modelId, expected]) => getModelContextLimit(modelId) !== expected)
      .map(([modelId, expected]) => `${modelId}: got ${getModelContextLimit(modelId)}, expected ${expected}`);

    expect(wrong).toEqual([]);
  });

  it('resolves each offered model by an exact key, not the catch-all default', () => {
    // 1,048,576 is the default. It sits close enough to a real 1M window to look
    // correct while meaning "no idea" - which is how `claude-opus-5` went
    // unnoticed. A model in the picker must never resolve to it by accident.
    for (const modelId of ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8']) {
      expect(getModelContextLimit(modelId)).not.toBe(DEFAULT_CONTEXT_LIMIT);
    }
  });

  it('knows the current Claude 5 family', () => {
    // These shipped after the previous snapshot was cut, so `claude-opus-5` fell
    // through to the 1,048,576 default - close enough to look right, which is
    // the worst way for a number to be wrong.
    expect(getModelContextLimit('claude-opus-5')).toBe(M);
    expect(getModelContextLimit('claude-sonnet-5')).toBe(M);
    expect(getModelContextLimit('claude-fable-5')).toBe(M);
  });

  it('does not claim Sonnet 4.5’s 1M beta window we never request', () => {
    // Guards the direction that actually breaks a turn: over-reporting means
    // compaction never fires before the real 200K ceiling is hit.
    expect(getModelContextLimit('claude-sonnet-4-5')).toBe(K200);
    expect(getModelContextLimit('claude-sonnet-4-5-20250929')).toBe(K200);
  });
});
