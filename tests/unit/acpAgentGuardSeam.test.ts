/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * AcpAgent native pre-tool guard seam - integration (mock) tests.
 *
 * Verifies the guard runs in handlePermissionRequest BEFORE the ApprovalStore
 * allow-cache short-circuit: a destructive command resolves the reject option
 * and never emits an acp_permission request, even when a cached "always allow"
 * decision exists. Benign commands proceed to the normal permission flow, and
 * disabling the guard (enabled:false) lets everything through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIsApproved } = vi.hoisted(() => ({ mockIsApproved: vi.fn(() => false) }));

vi.mock('../../src/process/agent/acp/AcpConnection', () => ({
  AcpConnection: class {
    hasActiveSession = true;
    isConnected = true;
    setConversationId = vi.fn();
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    onSessionUpdate: unknown = undefined;
    onPermissionRequest: unknown = undefined;
    onEndTurn: unknown = undefined;
    onPromptUsage: unknown = undefined;
    onFileOperation: unknown = undefined;
    onDisconnect: unknown = undefined;
  },
}));

vi.mock('../../src/process/agent/acp/AcpAdapter', () => ({
  AcpAdapter: class {
    convertSessionUpdate = vi.fn(() => []);
  },
}));

vi.mock('../../src/process/agent/acp/ApprovalStore', () => ({
  AcpApprovalStore: class {
    isApprovedForSession = mockIsApproved;
    put = vi.fn();
    get = vi.fn();
    clear = vi.fn();
  },
  createAcpApprovalKey: vi.fn(() => ({ kind: 'execute', title: 'shell', rawInput: {} })),
}));

vi.mock('../../src/process/agent/acp/utils', () => ({
  getClaudeModel: vi.fn().mockReturnValue(null),
  getClaudeModelSlot: vi.fn().mockReturnValue(null),
  killChild: vi.fn(),
  readTextFile: vi.fn(),
  writeJsonRpcMessage: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('../../src/process/services/ccSwitchModelSource', () => ({
  readClaudeModelInfoFromCcSwitch: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/process/agent/acp/modelInfo', () => ({
  buildAcpModelInfo: vi.fn(() => null),
  summarizeAcpModelInfo: vi.fn(),
}));

vi.mock('../../src/process/agent/acp/mcpSessionConfig', () => ({
  buildAcpSessionMcpServers: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/process/utils/mainLogger', () => ({ mainLog: vi.fn() }));

vi.mock('../../src/process/utils/shellEnv', () => ({
  getEnhancedEnv: vi.fn().mockReturnValue({}),
  resolveNpxPath: vi.fn().mockReturnValue('npx'),
  normalizeNpxArgsForBundledBun: vi.fn((a) => a),
}));

vi.mock('../../src/process/utils/initStorage', () => ({
  ProcessConfig: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
}));

import { AcpAgent } from '../../src/process/agent/acp/index';

type PermReq = {
  sessionId: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  toolCall: { toolCallId?: string; title?: string; kind?: string; rawInput?: Record<string, unknown> };
};

function makeAgent(): AcpAgent {
  return new AcpAgent({ id: 'acp-guard', backend: 'gemini', workingDir: '/tmp', onStreamEvent: vi.fn() });
}

function setGuard(agent: AcpAgent, enabled: boolean): void {
  const a = agent as unknown as { guardEnabled: boolean; guardRules: unknown[] };
  a.guardEnabled = enabled;
  a.guardRules = [];
}

function destructiveReq(): PermReq {
  return {
    sessionId: 's1',
    options: [
      { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'cancel_once', name: 'Reject', kind: 'reject_once' },
    ],
    toolCall: { toolCallId: 'c1', title: 'shell', kind: 'execute', rawInput: { command: 'rm -rf /' } },
  };
}

function call(agent: AcpAgent, data: PermReq): Promise<{ optionId: string }> {
  return (
    agent as unknown as { handlePermissionRequest: (d: PermReq) => Promise<{ optionId: string }> }
  ).handlePermissionRequest(data);
}

describe('AcpAgent guard seam - destructive DENY', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsApproved.mockReturnValue(false);
  });

  it('resolves the reject option and never emits acp_permission', async () => {
    const agent = makeAgent();
    setGuard(agent, true);
    const emitPerm = vi.spyOn(agent as never, 'emitPermissionRequest').mockImplementation(() => {});

    const result = await call(agent, destructiveReq());

    // The reject_once option id ('cancel_once') is what AcpConnection maps to a
    // rejected outcome (it treats any id containing "reject" the same way).
    expect(result.optionId).toBe('cancel_once');
    expect(emitPerm).not.toHaveBeenCalled();
  });

  it('a cached "always allow" is still overridden by the destructive floor', async () => {
    const agent = makeAgent();
    setGuard(agent, true);
    mockIsApproved.mockReturnValue(true); // cache says allow_always
    const emitPerm = vi.spyOn(agent as never, 'emitPermissionRequest').mockImplementation(() => {});

    const result = await call(agent, destructiveReq());

    // Guard ran before the cache: reject, NOT allow_always.
    expect(result.optionId).toBe('cancel_once');
    expect(result.optionId).not.toBe('allow_always');
    expect(emitPerm).not.toHaveBeenCalled();
  });

  it('falls back to reject_once when no reject option is offered', async () => {
    const agent = makeAgent();
    setGuard(agent, true);
    vi.spyOn(agent as never, 'emitPermissionRequest').mockImplementation(() => {});
    const data = destructiveReq();
    data.options = [{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' }];

    const result = await call(agent, data);
    expect(result.optionId).toBe('reject_once');
  });
});

describe('AcpAgent guard seam - allow / disabled passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsApproved.mockReturnValue(false);
  });

  it('a benign command proceeds to the normal permission flow', () => {
    const agent = makeAgent();
    setGuard(agent, true);
    const emitPerm = vi.spyOn(agent as never, 'emitPermissionRequest').mockImplementation(() => {});

    const data = destructiveReq();
    data.toolCall.rawInput = { command: 'git status' };
    void call(agent, data); // stays pending (awaits user) - executor runs synchronously

    expect(emitPerm).toHaveBeenCalledTimes(1);
  });

  it('enabled:false lets a destructive command reach the normal flow', () => {
    const agent = makeAgent();
    setGuard(agent, false);
    const emitPerm = vi.spyOn(agent as never, 'emitPermissionRequest').mockImplementation(() => {});

    void call(agent, destructiveReq());

    expect(emitPerm).toHaveBeenCalledTimes(1);
  });
});
