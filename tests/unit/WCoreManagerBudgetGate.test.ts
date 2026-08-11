/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The budget cap must reach the user, and the press must reach the engine.
 *
 * `budget_exceeded` used to end a turn with one info line. The engine publishes
 * a way back - `continue_with_budget` - and every piece of it existed except the
 * step where a human is asked: the command builder had no call sites at all.
 *
 * These tests drive the WHOLE producer, not the gate in isolation: the stream
 * callback the manager hands to `WCoreAgent`, the gate's rules, the request_id
 * ledger, and the JSON line that ends up at `sendCommand`. A gate that works
 * while nothing routes to it is the defect this file exists to catch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb, mockSendCommand, mockRequestUserConfirmation, mockResponseEmit, engine, agentOptions } = vi.hoisted(
  () => ({
    mockDb: {
      getConversationMessages: vi.fn(() => ({ data: [] })),
      getConversation: vi.fn(() => ({ success: false })),
      updateConversation: vi.fn(),
      createConversation: vi.fn(() => ({ success: true })),
      insertMessage: vi.fn(),
      updateMessage: vi.fn(),
    },
    mockSendCommand: vi.fn(),
    // Typed parameter on purpose: an untyped `vi.fn(async () => ...)` records a
    // zero-length call tuple, and reading `.mock.calls[0][0]` is then a type error.
    mockRequestUserConfirmation: vi.fn(async (_input: Record<string, unknown>) => ({
      approved: true,
      requestId: 'r1',
      fingerprint: 'fp',
    })),
    // The renderer-facing channel. Hoisted rather than inlined in the mock so a
    // test can assert what the user was actually TOLD - the failure this file
    // grew for is a grant that was never sent and never mentioned.
    mockResponseEmit: vi.fn(),
    // The engine's liveness, as `WCoreAgent.isAlive` reports it. Mutable,
    // because "the engine is gone" is the likely state after a budget cap and
    // has to be reachable from a test.
    engine: { alive: true },
    agentOptions: { current: null as null | { onStreamEvent: (event: unknown) => void } },
  })
);

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: { emit: mockResponseEmit },
      confirmation: { add: { emit: vi.fn() }, update: { emit: vi.fn() }, remove: { emit: vi.fn() } },
    },
    cron: { onJobCreated: { emit: vi.fn() }, onJobRemoved: { emit: vi.fn() } },
  },
}));

type FakePlatform = { paths: { isPackaged: () => boolean; getAppPath: () => null }; worker: { fork: unknown } };

vi.mock('@/common/platform', () => ({
  getPlatformServices: (): FakePlatform => ({
    paths: { isPackaged: () => false, getAppPath: () => null },
    worker: {
      fork: vi.fn(
        (): Record<string, unknown> => ({
          on: vi.fn().mockReturnThis(),
          postMessage: vi.fn(),
          kill: vi.fn(),
        })
      ),
    },
  }),
}));

vi.mock('@process/utils/shellEnv', () => ({ getEnhancedEnv: vi.fn(() => ({})) }));
vi.mock('@process/services/database', () => ({ getDatabase: vi.fn(() => Promise.resolve(mockDb)) }));
vi.mock('@process/services/database/export', () => ({ getDatabase: vi.fn(() => Promise.resolve(mockDb)) }));
vi.mock('@process/utils/initStorage', () => ({
  ProcessChat: { get: vi.fn(() => Promise.resolve([])) },
  ProcessConfig: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
}));
vi.mock('@process/utils/message', () => ({ addMessage: vi.fn(), addOrUpdateMessage: vi.fn() }));
vi.mock('@process/utils/mainLogger', () => ({ mainError: vi.fn(), mainLog: vi.fn(), mainWarn: vi.fn() }));
vi.mock('@process/services/cron/cronServiceSingleton', () => ({
  cronService: { addJob: vi.fn(), removeJob: vi.fn(), listJobsByConversation: vi.fn(async () => []) },
}));
vi.mock('@process/services/toolConfirmation', () => ({
  getToolConfirmationService: () => ({ requestUserConfirmation: mockRequestUserConfirmation }),
}));
// The system-prompt overlay reads skills off disk; irrelevant here and slow.
vi.mock('@process/task/agentUtils', () => ({ buildSystemInstructionsWithSkillsIndex: vi.fn(async () => undefined) }));

// A class, not `vi.fn().mockImplementation(...)`: the manager calls
// `new WCoreAgent(...)`, and an arrow-function implementation is not a
// constructor.
vi.mock('@process/agent/wcore', () => ({
  WCoreAgent: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
    kill = vi.fn();
    send = vi.fn().mockResolvedValue(undefined);
    approveTool = vi.fn();
    denyTool = vi.fn();
    setConfig = vi.fn();
    setMode = vi.fn();
    sendCommand = mockSendCommand;
    get isAlive(): boolean {
      return engine.alive;
    }
    capabilities: unknown = null;
    injectConversationHistory = vi.fn().mockResolvedValue(undefined);
    constructor(options: { onStreamEvent: (event: unknown) => void }) {
      agentOptions.current = options;
    }
  },
}));

// eslint-disable-next-line import/first
import { WCoreManager } from '@/process/task/WCoreManager';
// eslint-disable-next-line import/first
import { pendingBudgetGrantIds, resetBudgetGrants } from '@process/agent/wcore/capabilities/handlers/budgetGrants';
// eslint-disable-next-line import/first
import { MAX_BUDGET_GRANTS_PER_SESSION } from '@process/task/wcoreBudgetGate';

/** The engine's own cap event, as `WCoreAgent` forwards it (typed, no msg_id). */
const CAP_FRAME = {
  type: 'budget_exceeded',
  data: { reason: 'max_tokens_out', observed: '8192', limit: '4096' },
  msg_id: '',
};

async function startedManager(): Promise<WCoreManager> {
  const data = {
    workspace: '/test',
    model: { name: 'test', useModel: 'test-model', baseUrl: '', platform: 'test' },
    conversation_id: 'conv-budget',
    sessionMode: 'default',
  };
  const manager = new WCoreManager(data as never, data.model as never);
  await manager.start();
  return manager;
}

/** Let the gate's promise chain settle - the stream callback is fire-and-forget. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  resetBudgetGrants();
  engine.alive = true;
  agentOptions.current = null;
  mockRequestUserConfirmation.mockResolvedValue({ approved: true, requestId: 'r1', fingerprint: 'fp' });
});

describe('budget_exceeded reaches the user', () => {
  it('raises the confirmation dialog for the cap the engine reported', async () => {
    await startedManager();

    agentOptions.current?.onStreamEvent(CAP_FRAME);
    await settle();

    expect(mockRequestUserConfirmation).toHaveBeenCalledTimes(1);
    const input = mockRequestUserConfirmation.mock.calls[0][0] as {
      kind: string;
      details: Array<{ labelKey?: string; value: string }>;
    };
    expect(input.kind).toBe('agent.budgetGrant');
    // The cap's own numbers, and an amount labelled with its unit.
    expect(input.details.map((row) => row.value)).toEqual(expect.arrayContaining(['max_tokens_out', '8192', '4096']));
    expect(input.details.find((row) => row.labelKey === 'mcp.confirm.budgetGrant.grantTokens')?.value).toBe('4096');
  });

  it('sends continue_with_budget - once - when the user grants it', async () => {
    await startedManager();

    agentOptions.current?.onStreamEvent(CAP_FRAME);
    await settle();

    expect(mockSendCommand).toHaveBeenCalledTimes(1);
    const command = mockSendCommand.mock.calls[0][0] as Record<string, unknown>;
    expect(command.type).toBe('continue_with_budget');
    expect(command.additional_tokens).toBe(4096);
    expect(command.additional_cost_usd).toBeUndefined();
    expect(String(command.request_id)).toMatch(/^budget-/);
    // The ledger holds it, so the engine's answer can be correlated back.
    expect(pendingBudgetGrantIds()).toEqual([command.request_id]);
  });

  it('sends nothing when the user refuses', async () => {
    mockRequestUserConfirmation.mockResolvedValue({
      approved: false,
      requestId: 'r1',
      reason: 'declined',
      message: 'nothing was granted',
    } as never);
    await startedManager();

    agentOptions.current?.onStreamEvent(CAP_FRAME);
    await settle();

    expect(mockRequestUserConfirmation).toHaveBeenCalledTimes(1);
    expect(mockSendCommand).not.toHaveBeenCalled();
    expect(pendingBudgetGrantIds()).toEqual([]);
  });

  it('does not ask about a cap whose unit it cannot name', async () => {
    await startedManager();

    agentOptions.current?.onStreamEvent({
      ...CAP_FRAME,
      data: { reason: 'max_wall_clock', observed: '10', limit: '4' },
    });
    await settle();

    // No dialog, no command: a Grant button that could only fail is worse than
    // the info line the user already has.
    expect(mockRequestUserConfirmation).not.toHaveBeenCalled();
    expect(mockSendCommand).not.toHaveBeenCalled();
  });

  it('asks once for a cap delivered twice, and sends one command', async () => {
    // MEASURED before the in-flight ledger existed: the identical frame twice
    // raised TWO dialogs and sent TWO `continue_with_budget` commands with
    // different fresh request_ids - 8192 tokens granted for one 4096 overrun.
    // The engine cannot catch it either: fresh ids never collide, so
    // `request_id_conflict` never fires. `budgetGrants.ts` names this de-dupe
    // as the price of minting a fresh id per press.
    await startedManager();

    agentOptions.current?.onStreamEvent(CAP_FRAME);
    agentOptions.current?.onStreamEvent(CAP_FRAME);
    await settle();

    expect(mockRequestUserConfirmation).toHaveBeenCalledTimes(1);
    expect(mockSendCommand).toHaveBeenCalledTimes(1);
    expect(pendingBudgetGrantIds()).toHaveLength(1);
  });

  it('stops offering after the session grant limit, and says so once', async () => {
    // The amount granted is `observed - limit`, which raises the cap to what has
    // ALREADY been spent - so a resumed turn can re-trip it with new numbers,
    // and each re-trip is a new cap key and therefore a new dialog. Nothing else
    // in the host bounds that loop.
    await startedManager();

    for (let i = 0; i < MAX_BUDGET_GRANTS_PER_SESSION + 2; i += 1) {
      // Different observed each time: a genuine re-trip, not a duplicate frame.
      agentOptions.current?.onStreamEvent({
        ...CAP_FRAME,
        data: { reason: 'max_tokens_out', observed: String(8192 + i), limit: '4096' },
      });
      // Sequential on purpose, so `no-await-in-loop` does not apply: the cap
      // under test is a COUNT of completed grants, and delivering all frames at
      // once would exercise the in-flight de-dupe instead.
      // eslint-disable-next-line no-await-in-loop
      await settle();
    }

    expect(mockSendCommand).toHaveBeenCalledTimes(MAX_BUDGET_GRANTS_PER_SESSION);
    // Silently disabling the feature would be the same defect as the one this
    // file is about, so the limit reaches the transcript - once, not per cap.
    const limits = mockResponseEmit.mock.calls
      .map((call) => call[0] as { type?: string; data?: { code?: string } })
      .filter((frame) => frame.type === 'budget_grant_not_sent' && frame.data?.code === 'session_limit');
    expect(limits).toHaveLength(1);
  });

  it('tells the user when an approved grant could not be sent', async () => {
    // THE failure this surface exists for. With the engine unreachable - the
    // likely state, since `budget_exceeded` is what ended the turn - the dialog
    // still raises, the user presses Grant, `sendContinueWithBudget` returns
    // {ok:false}, and before this the ONLY trace was one mainLog line:
    // `respond.invoke` resolved {settled:true}, the modal closed, and the screen
    // was identical to a successful grant.
    engine.alive = false;
    await startedManager();

    agentOptions.current?.onStreamEvent(CAP_FRAME);
    await settle();

    expect(mockRequestUserConfirmation).toHaveBeenCalledTimes(1);
    expect(mockSendCommand).not.toHaveBeenCalled();
    const notices = mockResponseEmit.mock.calls
      .map((call) => call[0] as { type?: string; data?: { code?: string; tokens?: number } })
      .filter((frame) => frame.type === 'budget_grant_not_sent');
    expect(notices).toHaveLength(1);
    expect(notices[0].data?.code).toBe('undelivered');
    // It names the amount the user believes they granted.
    expect(notices[0].data?.tokens).toBe(4096);
  });

  it('says nothing when the user refused - there is nothing undelivered', async () => {
    // The counter-assertion for the test above: the notice must belong to a
    // PRESS. A refusal that emitted "your grant never arrived" would be a new
    // way to mislead, in the opposite direction.
    mockRequestUserConfirmation.mockResolvedValue({
      approved: false,
      requestId: 'r1',
      reason: 'declined',
      message: 'nothing was granted',
    } as never);
    engine.alive = false;
    await startedManager();

    agentOptions.current?.onStreamEvent(CAP_FRAME);
    await settle();

    const notices = mockResponseEmit.mock.calls
      .map((call) => call[0] as { type?: string })
      .filter((frame) => frame.type === 'budget_grant_not_sent');
    expect(notices).toEqual([]);
  });

  it('leaves every other stream event alone', async () => {
    await startedManager();

    agentOptions.current?.onStreamEvent({ type: 'info', data: 'Budget exceeded: max_tokens_out', msg_id: 'm1' });
    await settle();

    // The transcript line that accompanies the cap must not raise a second
    // dialog of its own.
    expect(mockRequestUserConfirmation).not.toHaveBeenCalled();
  });
});
