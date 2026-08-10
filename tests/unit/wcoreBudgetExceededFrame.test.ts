/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `budget_exceeded` must leave the decoder in a form a host can act on.
 *
 * The arm used to emit one prose line - "Budget exceeded: max_tokens_out
 * (observed 8192, limit 4096)" - and nothing else. That string is fine for the
 * transcript and useless to the budget gate: by the time it exists, the three
 * fields a `continue_with_budget` needs have been flattened into English.
 *
 * So the arm now emits both. These tests pin the pair: the notice the user
 * reads, and the typed frame the gate consumes - the latter with an EMPTY
 * msg_id, which is what keeps the manager's own guard from letting a second
 * bubble through beside the first.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@process/agent/wcore/binaryResolver', () => ({ resolveWCoreBinary: () => '/fake/wcore' }));
vi.mock('@process/agent/wcore/envBuilder', () => ({
  buildEngineSpawnEnv: () => ({}),
  buildSpawnConfig: () => ({
    args: [] as string[],
    env: {} as Record<string, string>,
    projectConfig: null as string | null,
    resolvedMaxTokens: undefined as number | undefined,
  }),
}));
vi.mock('@process/providers/ipc/modelRegistryIpc', () => ({ hydrateModelForSpawn: async (m: unknown) => m }));

// eslint-disable-next-line import/first
import { WCoreAgent } from '@process/agent/wcore/index';
// eslint-disable-next-line import/first
import { examplePayload } from '../helpers/engineContract';

type StreamEvent = { type: string; data: unknown; msg_id: string };

/** The engine's own cap event - reason, observed and limit come from the contract. */
const CAPPED = examplePayload('event', 'budget_exceeded');

function decode(event: Record<string, unknown>): StreamEvent[] {
  const events: StreamEvent[] = [];
  const agent = new WCoreAgent({
    workspace: '/tmp/ws',
    model: {} as never,
    onStreamEvent: (e: StreamEvent) => events.push(e),
  } as never);
  (agent as unknown as { handleEvent: (e: unknown) => void }).handleEvent(event);
  return events;
}

describe('WCoreAgent budget_exceeded', () => {
  it('emits a typed frame carrying the cap, the observed value and the limit', () => {
    const frames = decode(CAPPED).filter((e) => e.type === 'budget_exceeded');

    expect(frames).toHaveLength(1);
    // Field-for-field from the contract fixture: a gate cannot propose an
    // amount from prose.
    expect(frames[0].data).toEqual({
      reason: CAPPED.reason,
      observed: CAPPED.observed,
      limit: CAPPED.limit,
    });
  });

  it('keeps the typed frame out of the transcript by leaving msg_id empty', () => {
    const frame = decode(CAPPED).find((e) => e.type === 'budget_exceeded');

    // The manager drops empty-msg_id frames before the renderer. A msg_id here
    // would push this through transformMessage and render a junk bubble beside
    // the info line below.
    expect(frame?.msg_id).toBe('');
  });

  it('still shows the user why the turn stopped', () => {
    const info = decode(CAPPED).filter((e) => e.type === 'info');

    expect(info).toHaveLength(1);
    expect(String(info[0].data)).toContain(String(CAPPED.reason));
  });
});
