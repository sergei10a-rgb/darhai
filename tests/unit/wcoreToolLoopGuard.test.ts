/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-turn tool guards: a failing tool must not be retried without bound.
 *
 * Measured live: `video_analyze` returned HTTP 401 (the engine's internal
 * tools were reaching api.openai.com with an OpenRouter key), the agent then
 * retried through Bash / ffmpeg / cp / echo workarounds, and one video
 * attachment consumed 1.4M tokens against a 1M context window.
 *
 * The stall watchdog could not catch it BY CONSTRUCTION: every `tool_request`
 * pauses the timer and every frame resets it, so a busy failing loop keeps the
 * turn alive forever. These tests pin the two counters that do bound it, and -
 * just as important - the cases that must NOT trip so a long legitimate turn
 * with occasional failures still completes.
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
import {
  WCoreAgent,
  resolveToolCallsPerTurnLimit,
  resolveToolFailStreakLimit,
} from '@process/agent/wcore/index';

type StreamEvent = { type: string; data: unknown; msg_id: string };

const MSG_ID = 'msg-1';

function makeAgent() {
  const events: StreamEvent[] = [];
  const commands: unknown[] = [];
  const agent = new WCoreAgent({
    workspace: '/tmp/ws',
    model: {} as never,
    onStreamEvent: (e: StreamEvent) => events.push(e),
  } as never);

  (agent as unknown as { readyResolve: () => void }).readyResolve();
  (agent as unknown as { sendCommand: (c: unknown) => void }).sendCommand = (c) => commands.push(c);

  const fire = (event: Record<string, unknown>) =>
    (agent as unknown as { handleEvent: (e: unknown) => void }).handleEvent(event);

  return { agent, events, commands, fire };
}

/** One tool round-trip: request then result with the given status. */
const toolRoundTrip = (
  fire: (e: Record<string, unknown>) => void,
  callId: string,
  status: 'success' | 'error'
): void => {
  fire({ type: 'tool_request', call_id: callId, msg_id: MSG_ID, tool: { name: 'run_shell', description: 'x' } });
  fire({ type: 'tool_result', call_id: callId, msg_id: MSG_ID, tool_name: 'run_shell', status, output: '' });
};

const errorEvents = (events: StreamEvent[]): StreamEvent[] => events.filter((e) => e.type === 'error');
const stopCommands = (commands: unknown[]): unknown[] =>
  commands.filter((c) => (c as { type?: string }).type === 'stop');

describe('consecutive tool failures end the turn', () => {
  it('faults on the Nth consecutive failure with a single error frame and one stop', async () => {
    const { agent, events, commands, fire } = makeAgent();
    await agent.send('go', MSG_ID);
    commands.length = 0; // drop the outbound message command

    const limit = resolveToolFailStreakLimit();
    for (let i = 0; i < limit; i++) toolRoundTrip(fire, `call-${i}`, 'error');

    const errors = errorEvents(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].msg_id).toBe(MSG_ID);
    expect(String(errors[0].data)).toContain('дараалан');
    expect(stopCommands(commands)).toHaveLength(1);
  });

  it('does NOT fault one short of the limit - the turn is still usable', async () => {
    const { agent, events, fire } = makeAgent();
    await agent.send('go', MSG_ID);

    const limit = resolveToolFailStreakLimit();
    for (let i = 0; i < limit - 1; i++) toolRoundTrip(fire, `call-${i}`, 'error');

    expect(errorEvents(events)).toHaveLength(0);
  });

  it('a success RESETS the streak - the counter-check that keeps long turns alive', async () => {
    const { agent, events, fire } = makeAgent();
    await agent.send('go', MSG_ID);

    const limit = resolveToolFailStreakLimit();
    // limit-1 failures, one success, then limit-1 failures again: 2*(limit-1)
    // total failures, but never `limit` in a row.
    for (let i = 0; i < limit - 1; i++) toolRoundTrip(fire, `a-${i}`, 'error');
    toolRoundTrip(fire, 'ok', 'success');
    for (let i = 0; i < limit - 1; i++) toolRoundTrip(fire, `b-${i}`, 'error');

    expect(errorEvents(events)).toHaveLength(0);
  });

  it('faults only ONCE even if the engine keeps sending results afterwards', async () => {
    const { agent, events, commands, fire } = makeAgent();
    await agent.send('go', MSG_ID);
    commands.length = 0;

    const limit = resolveToolFailStreakLimit();
    for (let i = 0; i < limit + 5; i++) toolRoundTrip(fire, `call-${i}`, 'error');

    expect(errorEvents(events)).toHaveLength(1);
    expect(stopCommands(commands)).toHaveLength(1);
  });

  it('counters reset per turn - a fresh send starts clean', async () => {
    const { agent, events, fire } = makeAgent();
    const limit = resolveToolFailStreakLimit();

    await agent.send('go', MSG_ID);
    for (let i = 0; i < limit - 1; i++) toolRoundTrip(fire, `t1-${i}`, 'error');

    await agent.send('again', 'msg-2');
    for (let i = 0; i < limit - 1; i++) toolRoundTrip(fire, `t2-${i}`, 'error');

    // limit-1 in each turn; carrying the streak over would have faulted turn 2.
    expect(errorEvents(events)).toHaveLength(0);
  });
});

describe('per-turn tool-call backstop', () => {
  it('faults past the call cap even when every call SUCCEEDS (no failure streak)', async () => {
    const { agent, events, fire } = makeAgent();
    await agent.send('go', MSG_ID);

    const cap = resolveToolCallsPerTurnLimit();
    for (let i = 0; i <= cap; i++) toolRoundTrip(fire, `call-${i}`, 'success');

    const errors = errorEvents(events);
    expect(errors).toHaveLength(1);
    expect(String(errors[0].data)).toContain('хэрэгслийн дуудлага');
  });

  it('stays quiet at exactly the cap', async () => {
    const { agent, events, fire } = makeAgent();
    await agent.send('go', MSG_ID);

    const cap = resolveToolCallsPerTurnLimit();
    for (let i = 0; i < cap; i++) toolRoundTrip(fire, `call-${i}`, 'success');

    expect(errorEvents(events)).toHaveLength(0);
  });
});

describe('limit resolution', () => {
  it('defaults match the thresholds this codebase already uses for the same shape', () => {
    expect(resolveToolFailStreakLimit({})).toBe(5);
    expect(resolveToolCallsPerTurnLimit({})).toBe(100);
  });

  it('is overridable via DARHAI_* env, ignoring junk and non-positive values', () => {
    expect(resolveToolFailStreakLimit({ DARHAI_WCORE_MAX_TOOL_FAIL_STREAK: '3' })).toBe(3);
    expect(resolveToolCallsPerTurnLimit({ DARHAI_WCORE_MAX_TOOL_CALLS_PER_TURN: '250' })).toBe(250);
    expect(resolveToolFailStreakLimit({ DARHAI_WCORE_MAX_TOOL_FAIL_STREAK: 'abc' })).toBe(5);
    expect(resolveToolFailStreakLimit({ DARHAI_WCORE_MAX_TOOL_FAIL_STREAK: '0' })).toBe(5);
    expect(resolveToolFailStreakLimit({ DARHAI_WCORE_MAX_TOOL_FAIL_STREAK: '-2' })).toBe(5);
  });
});
