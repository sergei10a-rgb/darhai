/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The five usage figures the engine sends must survive the trip to the ring.
 *
 * `stream_end.usage` carries FIVE integers (schema:
 * `tests/fixtures/engine-contract/desktop/v1/schema/core-event.schema.json`,
 * `stream_end.usage`): `input_tokens`, `output_tokens`, `cache_read_tokens`,
 * `cache_write_tokens`, and `active_window_percent`. Four of them were thrown
 * away between the engine and the renderer's state, and the two that survived
 * were immediately added together into a single `totalTokens`.
 *
 * That sum is the correctness bug the ring showed: what SITS IN the context
 * window is `input_tokens`; adding `output_tokens` inflates the fill figure.
 * And `active_window_percent` is the engine's OWN fill measure, discarded in
 * favour of dividing the inflated sum by a hardcoded constant.
 *
 * The failure mode of the plumbing is silent - a dropped field is simply
 * `undefined` downstream, and a ring drawn from the wrong number still draws.
 * So this test walks the real path with the real fixture:
 *
 *     events/stream_end.json  ->  buildFinishPayload  (host, wcore/index.ts)
 *                             ->  toTokenUsage        (renderer state shape)
 *
 * It asserts the FIELD SET rather than only spot values, so narrowing anywhere
 * on that path fails here instead of showing up as a wrong percentage.
 *
 * SCOPE. This is a data-plumbing test. It deliberately makes no claim about
 * which figure the ring should divide by - that decision lives in
 * `ContextUsageIndicator`, and this file only proves the numbers are available
 * to it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CONTRACT_V1, examplePayload, validateEvent } from '../helpers/engineContract';
import { buildFinishPayload } from '@process/agent/wcore';
import { rehydrateTokenUsage, toTokenUsage } from '@renderer/pages/conversation/platforms/wcore/useWCoreMessage';
import type { TokenUsageData } from '@/common/config/storage';

/**
 * The engine's wire names, and what each becomes in renderer state.
 *
 * Written out as a table rather than asserted one `expect` at a time: the
 * regression being guarded against is a field going MISSING, and a table can be
 * iterated to prove the whole set arrived. Adding a sixth field to the contract
 * and forgetting the renderer should fail the "no field is dropped" test below.
 */
const USAGE_FIELDS: ReadonlyArray<{ wire: string; state: keyof TokenUsageData }> = [
  { wire: 'input_tokens', state: 'inputTokens' },
  { wire: 'output_tokens', state: 'outputTokens' },
  { wire: 'cache_read_tokens', state: 'cacheReadTokens' },
  { wire: 'cache_write_tokens', state: 'cacheWriteTokens' },
  { wire: 'active_window_percent', state: 'activeWindowPercent' },
];

const streamEnd = examplePayload('event', 'stream_end');
const fixtureUsage = streamEnd.usage as Record<string, number>;

describe('stream_end.usage: what the contract promises', () => {
  it('the published schema declares all five usage fields', () => {
    // Believe the schema over any prose description of it. If this fails, the
    // contract changed and the rest of this file is describing a dead shape.
    type SchemaVariant = {
      properties?: {
        type?: { const?: string };
        usage?: { properties?: Record<string, unknown> };
      };
    };
    const schema = JSON.parse(readFileSync(join(CONTRACT_V1, 'schema', 'core-event.schema.json'), 'utf-8')) as {
      oneOf: SchemaVariant[];
    };
    const node = schema.oneOf.find((v) => v.properties?.type?.const === 'stream_end');
    expect(node, 'schema has no stream_end variant').toBeDefined();

    const declared = Object.keys(node?.properties?.usage?.properties ?? {}).toSorted();
    expect(declared).toEqual([
      'active_window_percent',
      'cache_read_tokens',
      'cache_write_tokens',
      'input_tokens',
      'output_tokens',
    ]);
  });

  it('the fixture is a valid event and carries every declared field', () => {
    expect(validateEvent(streamEnd)).toEqual({ valid: true, errors: [] });
    for (const { wire } of USAGE_FIELDS) {
      expect(typeof fixtureUsage[wire], `fixture is missing ${wire}`).toBe('number');
    }
  });
});

describe('host forwarding (wcore/index.ts)', () => {
  it('forwards every usage field the engine sent', () => {
    const payload = buildFinishPayload(streamEnd) as Record<string, unknown>;
    for (const { wire } of USAGE_FIELDS) {
      expect(payload[wire], `host dropped ${wire}`).toBe(fixtureUsage[wire]);
    }
  });

  it('carries finish_reason alongside the figures', () => {
    const payload = buildFinishPayload(streamEnd) as Record<string, unknown>;
    expect(payload.finish_reason).toBe(streamEnd.finish_reason);
  });

  it('an unknown future field is forwarded rather than filtered', () => {
    // The schema sets `additionalProperties: true` on `usage`. A host that
    // whitelists today's five would silently swallow the sixth.
    const payload = buildFinishPayload({
      ...streamEnd,
      usage: { ...fixtureUsage, reasoning_tokens: 99 },
    }) as Record<string, unknown>;
    expect(payload.reasoning_tokens).toBe(99);
  });

  it('a turn with no usage and no reason yields the empty payload, as before', () => {
    // A ≤0.1.21 engine omits both fields. The renderer reads `''` as "nothing to
    // record"; emitting `{}` instead would overwrite a real reading with zeros.
    expect(buildFinishPayload({ usage: undefined, finish_reason: undefined })).toBe('');
  });
});

describe('renderer state shape (useWCoreMessage)', () => {
  const state = toTokenUsage(buildFinishPayload(streamEnd));

  it('keeps every figure the engine sent', () => {
    expect(state).not.toBeNull();
    for (const { wire, state: key } of USAGE_FIELDS) {
      expect(state?.[key], `renderer dropped ${wire}`).toBe(fixtureUsage[wire]);
    }
  });

  it('exposes input_tokens separately from the inflated sum', () => {
    // The whole point of the widening: what SITS IN the window (120) must be
    // reachable without the output tokens (40) folded in.
    expect(state?.inputTokens).toBe(120);
    expect(state?.totalTokens).toBe(160);
    expect(state?.inputTokens).toBeLessThan(state?.totalTokens ?? 0);
  });

  it('exposes the engine’s own fill measure', () => {
    expect(state?.activeWindowPercent).toBe(37);
  });

  it('keeps totalTokens as input+output for backward compatibility', () => {
    // Every existing reader (the ring, the acp and gemini paths, the `> 0`
    // rehydration guards) still gates on this field. Changing its meaning here
    // would move the bug rather than fix it.
    expect(state?.totalTokens).toBe(fixtureUsage.input_tokens + fixtureUsage.output_tokens);
  });

  it('preserves a zero figure instead of dropping it', () => {
    // `active_window_percent: 0` is a real reading - a fresh window. A `||`
    // chain or a truthiness filter would erase it, and an absent percent is not
    // the same claim as "0% full".
    const zeroed = toTokenUsage({ ...fixtureUsage, active_window_percent: 0, cache_read_tokens: 0 });
    expect(zeroed?.activeWindowPercent).toBe(0);
    expect(zeroed?.cacheReadTokens).toBe(0);
  });

  it('reports nothing at all for a payload that is not a usage object', () => {
    expect(toTokenUsage('')).toBeNull();
    expect(toTokenUsage(undefined)).toBeNull();
    expect(toTokenUsage({ finish_reason: 'stop' })).toBeNull();
  });

  it('ignores a non-numeric figure rather than storing NaN', () => {
    const dirty = toTokenUsage({ ...fixtureUsage, cache_read_tokens: 'lots' });
    expect(dirty?.cacheReadTokens).toBeUndefined();
    expect(dirty?.inputTokens).toBe(120);
  });
});

describe('migration: conversations persisted under the old single-field shape', () => {
  /**
   * `extra.lastTokenUsage` on disk is `{ totalTokens: number }` for every
   * conversation written before the widening. Those records are rehydrated on
   * open, so the new reader has to accept the old shape - reading it as zero
   * would empty a full ring on restart, and reading it as malformed would throw
   * inside the conversation-load effect.
   */
  it('a legacy record still reports its total', () => {
    const legacy = { totalTokens: 4200 } as TokenUsageData;
    const out = rehydrateTokenUsage(legacy);
    expect(out?.totalTokens).toBe(4200);
  });

  it('a legacy record leaves the new figures undefined, not zero', () => {
    // `undefined` means "the engine never told us", which a consumer must be
    // able to distinguish from a genuine 0. Defaulting to 0 here would let the
    // ring claim an empty context for a conversation that has a full one.
    const out = rehydrateTokenUsage({ totalTokens: 4200 } as TokenUsageData);
    expect(out?.inputTokens).toBeUndefined();
    expect(out?.activeWindowPercent).toBeUndefined();
  });

  it('a record written under the new shape round-trips whole', () => {
    const fresh = toTokenUsage(buildFinishPayload(streamEnd));
    expect(rehydrateTokenUsage(fresh)).toEqual(fresh);
  });

  it('keeps the legacy empty-usage semantics: a zero total is no reading', () => {
    expect(rehydrateTokenUsage({ totalTokens: 0 } as TokenUsageData)).toBeNull();
  });

  it('does not throw on a corrupt or absent record', () => {
    expect(rehydrateTokenUsage(null)).toBeNull();
    expect(rehydrateTokenUsage(undefined)).toBeNull();
    expect(rehydrateTokenUsage({} as TokenUsageData)).toBeNull();
    expect(rehydrateTokenUsage('nonsense' as unknown as TokenUsageData)).toBeNull();
  });

  it('accepts a record that has figures but no usable total', () => {
    // A turn that reported only a window percentage is still a reading. The old
    // `totalTokens > 0` gate would have discarded it silently.
    const out = rehydrateTokenUsage({ totalTokens: 0, activeWindowPercent: 37 } as TokenUsageData);
    expect(out?.activeWindowPercent).toBe(37);
  });
});
