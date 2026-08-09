/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * One tool decision must raise exactly ONE prompt.
 *
 * The engine announces a tool twice by design: `tool_request` (the call is
 * about to run) and `approval_required` (the HITL pause). Darhai answered both
 * with independent gates - the inline in-transcript prompt and the global
 * modal - so the user was asked the same question twice and the engine got two
 * replies for one `call_id`. Beyond the double prompt this was unsafe: the
 * modal path skips the native destructive-command guard, and in yolo mode the
 * inline path auto-approves while the orphaned modal later denies a call that
 * already ran.
 *
 * These tests pin: one prompt per call id in BOTH arrival orders, the guard
 * still running as a floor when the modal claimed the call first, and per-turn
 * cleanup so a recycled id cannot silently suppress a later prompt.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { emitConfirmationAdd, mockDb, mockApproveTool, mockDenyTool, mockRequestUserConfirmation } = vi.hoisted(() => ({
  emitConfirmationAdd: vi.fn(),
  mockDb: {
    getConversationMessages: vi.fn(() => ({ data: [] })),
    getConversation: vi.fn(() => ({ success: false })),
    updateConversation: vi.fn(),
    createConversation: vi.fn(() => ({ success: true })),
    insertMessage: vi.fn(),
    updateMessage: vi.fn(),
  },
  mockApproveTool: vi.fn(),
  mockDenyTool: vi.fn(),
  mockRequestUserConfirmation: vi.fn(async () => true),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: { emit: vi.fn() },
      confirmation: {
        add: { emit: emitConfirmationAdd },
        update: { emit: vi.fn() },
        remove: { emit: vi.fn() },
      },
    },
    cron: { onJobCreated: { emit: vi.fn() }, onJobRemoved: { emit: vi.fn() } },
  },
}));

type FakeWorker = { on: unknown; postMessage: unknown; kill: unknown };
type FakePlatform = { paths: { isPackaged: () => boolean; getAppPath: () => null }; worker: { fork: unknown } };

vi.mock('@/common/platform', () => ({
  getPlatformServices: (): FakePlatform => ({
    paths: { isPackaged: () => false, getAppPath: () => null },
    worker: {
      fork: vi.fn(
        (): FakeWorker => ({ on: vi.fn().mockReturnThis(), postMessage: vi.fn(), kill: vi.fn() })
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
vi.mock('@/common/utils', () => {
  let counter = 0;
  return { uuid: vi.fn(() => `uuid-${++counter}`) };
});
vi.mock('@process/utils/mainLogger', () => ({ mainError: vi.fn(), mainLog: vi.fn(), mainWarn: vi.fn() }));
vi.mock('@process/services/cron/cronServiceSingleton', () => ({
  cronService: { addJob: vi.fn(), removeJob: vi.fn(), listJobsByConversation: vi.fn(async () => []) },
}));
vi.mock('@process/services/toolConfirmation', () => ({
  getToolConfirmationService: () => ({ requestUserConfirmation: mockRequestUserConfirmation }),
}));

vi.mock('@process/agent/wcore', () => ({
  WCoreAgent: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    kill: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    approveTool: mockApproveTool,
    denyTool: mockDenyTool,
    setConfig: vi.fn(),
    setMode: vi.fn(),
    get bootstrap() {
      return Promise.resolve();
    },
  })),
}));

// eslint-disable-next-line import/first
import { WCoreManager } from '@/process/task/WCoreManager';

type Content = {
  callId: string;
  name: string;
  status: 'Confirming';
  confirmationDetails: Record<string, unknown>;
};

function createManager(sessionMode = 'default'): WCoreManager {
  const data = {
    workspace: '/test',
    model: { name: 'test', useModel: 'test-model', baseUrl: '', platform: 'test' },
    conversation_id: 'conv-dedup',
    sessionMode,
  };
  const manager = new WCoreManager(data as never, data.model as never);
  (manager as unknown as { agent: unknown }).agent = {
    approveTool: mockApproveTool,
    denyTool: mockDenyTool,
    stop: vi.fn(),
  };
  const m = manager as unknown as { guardEnabled: boolean; guardRules: unknown[] };
  m.guardEnabled = true;
  m.guardRules = [];
  return manager;
}

const execContent = (command: string, callId = 'call-1'): Content => ({
  callId,
  name: 'run_shell',
  status: 'Confirming',
  confirmationDetails: { type: 'exec', title: 'shell', rootCommand: command.split(' ')[0], command },
});

/** The inline path (engine `tool_request`). */
const inline = (manager: WCoreManager, content: Content): void => {
  (manager as unknown as { handleConformationMessage: (msg: unknown) => void }).handleConformationMessage({
    content: [content],
  });
};

/** The modal path (engine `approval_required`). */
const modal = (manager: WCoreManager, callId: string): Promise<void> =>
  (manager as unknown as { resolveEngineApproval: (e: unknown) => Promise<void> }).resolveEngineApproval({
    data: { callId, reason: 'exec', context: 'Execute: cp a b' },
  });

afterEach(() => vi.clearAllMocks());

describe('one decision, one prompt', () => {
  it('inline first: the modal does NOT raise a second prompt for the same call id', async () => {
    const manager = createManager();

    inline(manager, execContent('cp a b'));
    await modal(manager, 'call-1');

    expect(emitConfirmationAdd).toHaveBeenCalledTimes(1);
    expect(mockRequestUserConfirmation).not.toHaveBeenCalled();
  });

  it('modal first: the inline path does NOT raise a second prompt', async () => {
    const manager = createManager();

    await modal(manager, 'call-1');
    inline(manager, execContent('cp a b'));

    expect(mockRequestUserConfirmation).toHaveBeenCalledTimes(1);
    expect(emitConfirmationAdd).not.toHaveBeenCalled();
  });

  it('a DIFFERENT call id still gets its own prompt', async () => {
    const manager = createManager();

    inline(manager, execContent('cp a b', 'call-1'));
    await modal(manager, 'call-2');

    expect(emitConfirmationAdd).toHaveBeenCalledTimes(1);
    expect(mockRequestUserConfirmation).toHaveBeenCalledTimes(1);
  });
});

describe('the destructive-command guard stays a floor', () => {
  it('runs even when the modal claimed the call first', async () => {
    const manager = createManager();

    await modal(manager, 'call-1');
    inline(manager, execContent('rm -rf /'));

    // Guard denied it despite the modal owning the prompt.
    expect(mockDenyTool).toHaveBeenCalledWith('call-1', expect.any(String));
    // And the inline prompt was still suppressed - no double ask.
    expect(emitConfirmationAdd).not.toHaveBeenCalled();
  });

  it('yolo mode does not auto-approve behind a modal that already owns the call', async () => {
    const manager = createManager('yolo');

    await modal(manager, 'call-1');
    mockApproveTool.mockClear(); // the modal's own approval is not what we assert
    inline(manager, execContent('cp a b'));

    // Without the claim, yolo would fire a second approveTool for the same id.
    expect(mockApproveTool).not.toHaveBeenCalled();
  });
});

describe('per-turn cleanup', () => {
  it('clears claims on stop so a recycled call id is not silently suppressed', async () => {
    const manager = createManager();

    inline(manager, execContent('cp a b'));
    await manager.stop();
    await modal(manager, 'call-1');

    // New turn, same id: the modal must be free to prompt again.
    expect(mockRequestUserConfirmation).toHaveBeenCalledTimes(1);
  });
});
