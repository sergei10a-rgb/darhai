/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A health check that can hang is worse than one that fails: the UI cannot tell
 * it apart from "still working". The functional audit measured
 * `acp.check-agent-health` for goose still unresolved after 180s with nothing
 * shown to the user, because every step was awaited with no deadline.
 *
 * These tests pin the three properties that fix depends on: the sequence runs
 * against one wall-clock budget, a timeout is reported as a real failure naming
 * the phase, and the stalled subprocess is closed rather than orphaned.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const { registryMock, clientMock, factoryCreate } = vi.hoisted(() => {
  const client = {
    start: vi.fn(async () => ({})),
    createSession: vi.fn(async () => ({ sessionId: 's1' })),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    close: vi.fn(async () => {}),
  };
  return {
    clientMock: client,
    factoryCreate: vi.fn(() => client),
    registryMock: {
      whenReady: vi.fn(async () => {}),
      getDetectedAgents: vi.fn(() => [
        { backend: 'goose', kind: 'acp', name: 'Goose', cliPath: 'goose', acpArgs: ['acp'] },
      ]),
    },
  };
});

vi.mock('@process/agent/AgentRegistry', () => ({ agentRegistry: registryMock }));
vi.mock('@process/acp/compat/LegacyConnectorFactory', () => ({
  LegacyConnectorFactory: vi.fn(function () {
    return { create: factoryCreate };
  }),
}));
vi.mock('@process/acp/types', () => ({ noopProtocolHandlers: {} }));

import { checkAgentHealth, HEALTH_CHECK_BUDGET_MS } from '../../src/process/bridge/agent/checkAgentHealth';

/** A promise that never settles - the exact shape of the audited hang. */
const never = () => new Promise<never>(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  clientMock.start.mockImplementation(async () => ({}) as never);
  clientMock.createSession.mockImplementation(async () => ({ sessionId: 's1' }) as never);
  clientMock.prompt.mockImplementation(async () => ({ stopReason: 'end_turn' }) as never);
  clientMock.close.mockImplementation(async () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('checkAgentHealth', () => {
  it('reports availability and latency for a healthy round trip', async () => {
    const result = await checkAgentHealth('goose');

    expect(result.success).toBe(true);
    expect(result.data?.available).toBe(true);
    expect(clientMock.prompt).toHaveBeenCalledWith('s1', [{ type: 'text', text: 'hi' }]);
    expect(clientMock.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['start', () => clientMock.start.mockImplementation(never)],
    ['session', () => clientMock.createSession.mockImplementation(never)],
    ['prompt', () => clientMock.prompt.mockImplementation(never)],
  ])('bounds a stalled "%s" and names the phase in the error', async (phase, stall) => {
    stall();

    const pending = checkAgentHealth('goose');
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_BUDGET_MS + 10);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.msg).toContain(`timed out after ${HEALTH_CHECK_BUDGET_MS}ms`);
    expect(result.msg).toContain(phase);
    expect(result.data?.available).toBe(false);
    // The subprocess must be terminated, not left running behind a dead promise.
    expect(clientMock.close).toHaveBeenCalledTimes(1);
  });

  it('spends one budget across the whole sequence, not one per step', async () => {
    // Two steps that each take 60% of the budget must exhaust it together.
    const slow = () => new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_BUDGET_MS * 0.6));
    clientMock.start.mockImplementation(slow as never);
    clientMock.createSession.mockImplementation(slow as never);

    const pending = checkAgentHealth('goose');
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_BUDGET_MS + 10);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.msg).toContain('session');
    expect(clientMock.prompt).not.toHaveBeenCalled();
  });

  it('distinguishes an auth failure from a timeout', async () => {
    clientMock.start.mockRejectedValue(new Error('Not authenticated: please login'));

    const result = await checkAgentHealth('goose');

    expect(result.success).toBe(false);
    expect(result.msg).toBe('goose not authenticated');
    expect(result.data?.error).toBe('Not authenticated');
  });

  it('waits for agent detection before deciding the CLI is missing', async () => {
    const order: string[] = [];
    registryMock.whenReady.mockImplementation(async () => {
      order.push('whenReady');
    });
    registryMock.getDetectedAgents.mockImplementation(() => {
      order.push('getDetectedAgents');
      return [];
    });

    const result = await checkAgentHealth('goose');

    expect(order).toEqual(['whenReady', 'getDetectedAgents']);
    expect(result.data?.error).toBe('CLI not installed');
  });
});
