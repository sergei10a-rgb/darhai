/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Accept Edits permission gate (1f3926f06).
 *
 * The mode advertised "Auto-approve file edits, prompt for commands" but the
 * manager gate only auto-approved yolo and team-MCP tools - every edit still
 * prompted. These tests pin the gate at the real AcpAgentManager:
 * (acceptEdits, edit) auto-confirms with the ALLOW option even when a reject
 * option is listed first; (acceptEdits, execute) and (default, edit) prompt.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockNotifyCompletion } = vi.hoisted(() => ({
  mockNotifyCompletion: vi.fn(() => Promise.resolve()),
}));

vi.mock('@process/services/cron/CronBusyGuard', () => ({
  cronBusyGuard: { setProcessing: vi.fn(), isProcessing: vi.fn(() => false) },
}));
vi.mock('@process/utils/mainLogger', () => ({
  mainLog: vi.fn(),
  mainWarn: vi.fn(),
  mainError: vi.fn(),
}));
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { getConfig: vi.fn(() => ({})), get: vi.fn() },
}));
vi.mock('@/common', () => ({
  ipcBridge: { acpConversation: { responseStream: { emit: vi.fn() } } },
}));
vi.mock('@process/services/database', () => ({
  getDatabase: vi.fn(() => Promise.resolve({ updateConversation: vi.fn() })),
}));
vi.mock('@process/utils/message', () => ({
  addMessage: vi.fn(),
  addOrUpdateMessage: vi.fn(),
  nextTickToLocalFinish: vi.fn((cb: () => void) => cb()),
}));
vi.mock('@process/channels/agent/ChannelEventBus', () => ({
  channelEventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emitAgentMessage: vi.fn(),
  },
}));
vi.mock('@process/utils/previewUtils', () => ({ handlePreviewOpenEvent: vi.fn() }));
vi.mock('@process/extensions', () => ({
  ExtensionRegistry: {
    getInstance: vi.fn(() => ({ getAll: vi.fn(() => []), getAcpAdapters: vi.fn(() => []) })),
  },
}));
vi.mock('@process/agent/acp', () => ({
  AcpAgent: class {
    sendMessage = vi.fn();
    stop = vi.fn();
    kill = vi.fn();
    cancelPrompt = vi.fn();
  },
}));
vi.mock('@process/task/BaseAgentManager', () => ({
  default: class {
    conversation_id = '';
    status: string | undefined;
    workspace = '';
    bootstrapping = false;
    yoloMode = false;
    constructor(_type: string, data: Record<string, unknown>, _emitter: unknown) {
      if (data?.conversation_id) this.conversation_id = data.conversation_id as string;
      if (data?.workspace) this.workspace = data.workspace as string;
    }
    isYoloMode() {
      return false;
    }
    addConfirmation() {}
    getConfirmations(): unknown[] {
      return [];
    }
  },
}));
vi.mock('@process/task/ConversationTurnCompletionService', () => ({
  ConversationTurnCompletionService: {
    getInstance: () => ({ notifyPotentialCompletion: mockNotifyCompletion }),
  },
}));
vi.mock('@process/task/IpcAgentEventEmitter', () => ({ IpcAgentEventEmitter: vi.fn() }));
vi.mock('@process/task/CronCommandDetector', () => ({ hasCronCommands: vi.fn(() => false) }));
vi.mock('@process/task/MessageMiddleware', () => ({
  extractTextFromMessage: vi.fn(() => ''),
  processCronInMessage: vi.fn((x: unknown) => x),
}));
vi.mock('@process/task/ThinkTagDetector', () => ({ stripThinkTags: vi.fn((x: unknown) => x) }));
vi.mock('@process/utils/initAgent', () => ({ hasNativeSkillSupport: vi.fn(() => false) }));
vi.mock('@process/task/agentUtils', () => ({
  prepareFirstMessageWithSkillsIndex: vi.fn((x: string) => Promise.resolve({ content: x, loadedSkills: [] })),
}));
vi.mock('@/common/utils', () => ({ parseError: vi.fn((e: unknown) => e), uuid: vi.fn(() => 'test-uuid') }));
vi.mock('@/common/chat/chatLib', () => ({ transformMessage: vi.fn(), uuid: vi.fn(() => 'uuid') }));

// ── Import real AcpAgentManager after all mocks are set up ───────────────────
import AcpAgentManager from '../../src/process/task/AcpAgentManager';
import type { AcpBackend } from '../../src/common/types/acpTypes';

type PermissionOption = { optionId: string; name: string; kind: string };

function makeManager(mode: string) {
  const manager = new AcpAgentManager({
    conversation_id: 'conv-gate',
    backend: 'claude' as AcpBackend,
    workspace: '/tmp/workspace',
  });
  (manager as unknown as { currentMode: string }).currentMode = mode;
  const confirm = vi.fn();
  const addConfirmation = vi.fn();
  (manager as unknown as { confirm: typeof confirm }).confirm = confirm;
  (manager as unknown as { addConfirmation: typeof addConfirmation }).addConfirmation = addConfirmation;
  return { manager, confirm, addConfirmation };
}

// Reject listed FIRST: a gate that blindly took options[0] would auto-REJECT.
const OPTIONS: PermissionOption[] = [
  { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
  { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
];

async function fireEditPermission(manager: AcpAgentManager, kind: string) {
  await (
    manager as unknown as {
      handleSignalEvent: (v: unknown, backend: AcpBackend) => Promise<void>;
    }
  ).handleSignalEvent(
    {
      type: 'acp_permission',
      msg_id: 'msg-1',
      conversation_id: 'conv-gate',
      data: {
        toolCall: { toolCallId: 'tc-1', title: 'Edit file', kind, rawInput: {} },
        options: OPTIONS,
      },
    },
    'claude'
  );
}

describe('AcpAgentManager Accept Edits gate (1f3926f06)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-approves an edit in acceptEdits mode with the ALLOW option', async () => {
    const { manager, confirm, addConfirmation } = makeManager('acceptEdits');

    await fireEditPermission(manager, 'edit');
    vi.advanceTimersByTime(60);

    expect(confirm).toHaveBeenCalledWith('msg-1', 'tc-1', OPTIONS[1]);
    expect(addConfirmation).not.toHaveBeenCalled();
  });

  it('still prompts for a command in acceptEdits mode', async () => {
    const { manager, confirm, addConfirmation } = makeManager('acceptEdits');

    await fireEditPermission(manager, 'execute');
    vi.advanceTimersByTime(60);

    expect(addConfirmation).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('still prompts for an edit in default mode', async () => {
    const { manager, confirm, addConfirmation } = makeManager('default');

    await fireEditPermission(manager, 'edit');
    vi.advanceTimersByTime(60);

    expect(addConfirmation).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });
});
