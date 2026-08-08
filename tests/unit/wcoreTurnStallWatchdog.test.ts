/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WCore per-turn stall watchdog (e41615065).
 *
 * The process-level heartbeat (ping/pong) only detects a DEAD process; an
 * engine that keeps answering ping while emitting no turn frames leaves the
 * chat stuck on 'working' forever. The watchdog faults a turn that makes no
 * msg_id-bearing forward progress for the timeout, sending `stop` and a
 * terminal error frame.
 *
 * Tests drive the private handleEvent / send with fake timers. The spawn path
 * is never touched: send() awaits readyPromise, which we resolve directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep the heavy spawn-time deps inert - the test only exercises the timer
// state machine, never a real child process.
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

type StreamEvent = { type: string; data: unknown; msg_id: string };

const TIMEOUT_MS = 600_000; // matches DEFAULT_TURN_STALL_TIMEOUT_MS

function makeAgent() {
  const events: StreamEvent[] = [];
  const commands: unknown[] = [];
  const agent = new WCoreAgent({
    workspace: '/tmp/ws',
    model: {} as never,
    onStreamEvent: (e: StreamEvent) => events.push(e),
  } as never);

  // send() awaits readyPromise; resolve it so send proceeds without a spawn.
  (agent as unknown as { readyResolve: () => void }).readyResolve();
  // Capture outbound commands instead of writing to a (nonexistent) child.
  (agent as unknown as { sendCommand: (c: unknown) => void }).sendCommand = (c) => commands.push(c);

  const fire = (event: Record<string, unknown>) =>
    (agent as unknown as { handleEvent: (e: unknown) => void }).handleEvent(event);

  return { agent, events, commands, fire };
}

const errorFrames = (events: StreamEvent[]) => events.filter((e) => e.type === 'error');
const stopCommands = (commands: unknown[]) => commands.filter((c) => (c as { type?: string }).type === 'stop');

describe('WCoreAgent turn stall watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('faults a silent turn after the timeout with exactly one error + stop', async () => {
    const { agent, events, commands } = makeAgent();
    await agent.send('hi', 'm1');

    vi.advanceTimersByTime(TIMEOUT_MS);

    const errs = errorFrames(events);
    expect(errs).toHaveLength(1);
    expect(errs[0].msg_id).toBe('m1');
    expect(stopCommands(commands)).toHaveLength(1);

    // Idempotent: no second fault after further silence.
    vi.advanceTimersByTime(TIMEOUT_MS * 2);
    expect(errorFrames(events)).toHaveLength(1);
  });

  it('a msg_id-bearing frame defers the deadline', async () => {
    const { agent, events, fire } = makeAgent();
    await agent.send('hi', 'm1');

    vi.advanceTimersByTime(TIMEOUT_MS * 0.9);
    fire({ type: 'text_delta', msg_id: 'm1', text: 'partial' }); // forward progress
    vi.advanceTimersByTime(TIMEOUT_MS * 0.9); // total 1.8x, but deadline was reset

    expect(errorFrames(events)).toHaveLength(0);
  });

  it('a pong does NOT defer the deadline (heartbeat is not progress)', async () => {
    const { agent, events, fire } = makeAgent();
    await agent.send('hi', 'm1');

    vi.advanceTimersByTime(TIMEOUT_MS * 0.9);
    fire({ type: 'pong' }); // no msg_id → must not reset
    vi.advanceTimersByTime(TIMEOUT_MS * 0.2); // crosses the original deadline

    expect(errorFrames(events)).toHaveLength(1);
  });

  it('pauses during a tool run and resumes on its result', async () => {
    const { agent, events, fire } = makeAgent();
    await agent.send('hi', 'm1');

    fire({ type: 'tool_request', msg_id: 'm1', call_id: 'c1', tool: { name: 't', description: '' } });
    // Silence far past the timeout while the tool is running: must NOT fire.
    vi.advanceTimersByTime(TIMEOUT_MS * 3);
    expect(errorFrames(events)).toHaveLength(0);

    // Tool finishes → deadline resumes; silence again crosses it → fires once.
    fire({ type: 'tool_result', msg_id: 'm1', call_id: 'c1', tool_name: 't', status: 'success', output: 'ok' });
    vi.advanceTimersByTime(TIMEOUT_MS);
    expect(errorFrames(events)).toHaveLength(1);
  });

  it('disarms on stream_end so a completed turn never faults', async () => {
    const { agent, events, fire } = makeAgent();
    await agent.send('hi', 'm1');

    fire({ type: 'stream_end', msg_id: 'm1' });
    vi.advanceTimersByTime(TIMEOUT_MS * 2);

    expect(errorFrames(events)).toHaveLength(0);
  });
});
