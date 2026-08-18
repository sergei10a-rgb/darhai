/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * WCoreManager native pre-tool guard seam - integration (mock) tests.
 *
 * Verifies the guard runs in handleConformationMessage BEFORE tryAutoApprove
 * and the approval-store cache: a destructive command is denied via the agent's
 * denyTool and never reaches addConfirmation or an auto-approve, even in yolo
 * mode. Benign commands fall through to the normal flow, and disabling the
 * guard (enabled:false) lets everything through.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const {
  emitResponseStream,
  emitConfirmationAdd,
  emitConfirmationUpdate,
  emitConfirmationRemove,
  mockDb,
  mockApproveTool,
  mockDenyTool,
} = vi.hoisted(() => ({
  emitResponseStream: vi.fn(),
  emitConfirmationAdd: vi.fn(),
  emitConfirmationUpdate: vi.fn(),
  emitConfirmationRemove: vi.fn(),
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
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: { emit: emitResponseStream },
      confirmation: {
        add: { emit: emitConfirmationAdd },
        update: { emit: emitConfirmationUpdate },
        remove: { emit: emitConfirmationRemove },
      },
    },
    cron: { onJobCreated: { emit: vi.fn() }, onJobRemoved: { emit: vi.fn() } },
  },
}));

vi.mock('@/common/platform', () => ({
  getPlatformServices: () => ({
    paths: { isPackaged: () => false, getAppPath: () => null },
    worker: { fork: vi.fn(() => ({ on: vi.fn().mockReturnThis(), postMessage: vi.fn(), kill: vi.fn() })) },
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

import { WCoreManager } from '@/process/task/WCoreManager';

type Content = {
  callId: string;
  name: string;
  description?: string;
  status: 'Confirming';
  confirmationDetails: Record<string, unknown>;
};

function createManager(sessionMode: string): WCoreManager {
  const data = {
    workspace: '/test',
    model: { name: 'test', useModel: 'test-model', baseUrl: '', platform: 'test' },
    conversation_id: 'conv-guard',
    sessionMode,
  };
  const manager = new WCoreManager(data as never, data.model as never);
  (manager as unknown as { agent: unknown }).agent = { approveTool: mockApproveTool, denyTool: mockDenyTool };
  return manager;
}

function execContent(command: string, callId = 'call-1'): Content {
  return {
    callId,
    name: 'run_shell',
    status: 'Confirming',
    confirmationDetails: { type: 'exec', title: 'shell', rootCommand: command.split(' ')[0], command },
  };
}

function setGuard(manager: WCoreManager, enabled: boolean): void {
  const m = manager as unknown as { guardEnabled: boolean; guardRules: unknown[] };
  m.guardEnabled = enabled;
  m.guardRules = [];
}

function handle(manager: WCoreManager, content: Content): void {
  (manager as unknown as { handleConformationMessage: (msg: unknown) => void }).handleConformationMessage({
    content: [content],
  });
}

describe('WCoreManager guard seam - destructive DENY', () => {
  afterEach(() => vi.clearAllMocks());

  it('denies a destructive command via denyTool, never addConfirmation/approve', () => {
    const manager = createManager('default');
    setGuard(manager, true);

    handle(manager, execContent('rm -rf /'));

    expect(mockDenyTool).toHaveBeenCalledWith('call-1', expect.any(String));
    expect(mockApproveTool).not.toHaveBeenCalled();
    expect(emitConfirmationAdd).not.toHaveBeenCalled();
  });

  it('yolo mode + destructive is still denied (guard runs before auto-approve)', () => {
    const manager = createManager('yolo');
    setGuard(manager, true);

    handle(manager, execContent('mkfs.ext4 /dev/sda1'));

    expect(mockDenyTool).toHaveBeenCalledWith('call-1', expect.any(String));
    expect(mockApproveTool).not.toHaveBeenCalled();
    expect(emitConfirmationAdd).not.toHaveBeenCalled();
  });
});

describe('WCoreManager guard seam - allow / disabled passthrough', () => {
  afterEach(() => vi.clearAllMocks());

  it('a benign command falls through to the normal confirmation flow', () => {
    const manager = createManager('default');
    setGuard(manager, true);

    handle(manager, execContent('git status'));

    expect(mockDenyTool).not.toHaveBeenCalled();
    expect(emitConfirmationAdd).toHaveBeenCalledTimes(1);
  });

  it('enabled:false lets a destructive command through to the normal flow', () => {
    const manager = createManager('default');
    setGuard(manager, false);

    handle(manager, execContent('rm -rf /'));

    expect(mockDenyTool).not.toHaveBeenCalled();
    expect(emitConfirmationAdd).toHaveBeenCalledTimes(1);
  });
});

describe('WCoreManager guard seam - repeat-tool-reminder', () => {
  afterEach(() => vi.clearAllMocks());

  /** The system messages the manager streamed - the reminder's delivery path. */
  function systemNotices(): string[] {
    return emitResponseStream.mock.calls
      .map((c) => c[0] as { type?: string; data?: string })
      .filter((a) => a?.type === 'system')
      .map((a) => a.data ?? '');
  }

  it('nudges once the same benign tool call repeats to the first threshold (3)', () => {
    const manager = createManager('default');
    setGuard(manager, false); // guard off: isolate the reminder from deny/warn

    handle(manager, execContent('git status', 'c1'));
    handle(manager, execContent('git status', 'c2'));
    expect(systemNotices(), 'no nudge before the threshold').toHaveLength(0);

    handle(manager, execContent('git status', 'c3'));
    expect(systemNotices(), 'the 3rd identical attempt nudges').toHaveLength(1);
  });

  it('observes each tool call once - a restreamed callId does not double-count', () => {
    const manager = createManager('default');
    setGuard(manager, false);

    // Same callId restreams as its status advances; the chain must not advance.
    handle(manager, execContent('git status', 'same'));
    handle(manager, execContent('git status', 'same'));
    handle(manager, execContent('git status', 'same'));

    expect(systemNotices(), 'one distinct callId is count 1, never hits 3').toHaveLength(0);
  });

  it('a new user turn resets the chain (sendMessage)', async () => {
    const manager = createManager('default');
    setGuard(manager, false);

    handle(manager, execContent('git status', 'c1'));
    handle(manager, execContent('git status', 'c2'));
    handle(manager, execContent('git status', 'c3'));
    expect(systemNotices()).toHaveLength(1);

    vi.clearAllMocks();
    // A user turn is a context change - the manager resets the chain at the top
    // of sendMessage (before any agent I/O), so the next three identical
    // attempts nudge again. The agent send is mocked and its result irrelevant.
    (manager as unknown as { agent: { send: unknown } }).agent.send = vi.fn().mockResolvedValue(undefined);
    await manager.sendMessage({ content: 'carry on', msg_id: 'm-turn-2' }).catch(() => undefined);

    handle(manager, execContent('git status', 'd1'));
    handle(manager, execContent('git status', 'd2'));
    handle(manager, execContent('git status', 'd3'));
    expect(systemNotices(), 'chain reset by the new turn, so the 3rd nudges').toHaveLength(1);
  });
});
