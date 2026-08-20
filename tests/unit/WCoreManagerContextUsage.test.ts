/**
 * GAP-2: WCoreManager Context Usage Persistence - Black-box tests
 *
 * Tests based on GAP-2-plan.md acceptance criteria.
 * Validates that WCoreManager persists token usage from stream_end
 * to the conversation's extra.lastTokenUsage in the database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────

const {
  emitResponseStream,
  emitConfirmationAdd,
  emitConfirmationUpdate,
  emitConfirmationRemove,
  mockDb,
  mockTeamEventBusEmit,
  mockChannelEmitAgentMessage,
} = vi.hoisted(() => ({
  emitResponseStream: vi.fn(),
  emitConfirmationAdd: vi.fn(),
  emitConfirmationUpdate: vi.fn(),
  emitConfirmationRemove: vi.fn(),
  mockDb: {
    getConversationMessages: vi.fn(() => ({ data: [] })),
    getConversation: vi.fn(() => ({ success: true, data: { type: 'wcore', extra: {} } })),
    updateConversation: vi.fn(),
    createConversation: vi.fn(() => ({ success: true })),
    insertMessage: vi.fn(),
    updateMessage: vi.fn(),
  },
  mockTeamEventBusEmit: vi.fn(),
  mockChannelEmitAgentMessage: vi.fn(),
}));

// ── Module mocks ───────────────────────────────────────────────────

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
    cron: {
      onJobCreated: { emit: vi.fn() },
      onJobRemoved: { emit: vi.fn() },
    },
  },
}));

vi.mock('@process/team/teamEventBus', () => ({
  teamEventBus: { emit: mockTeamEventBusEmit },
}));

vi.mock('@process/channels/agent/ChannelEventBus', () => ({
  channelEventBus: { emitAgentMessage: mockChannelEmitAgentMessage },
}));

vi.mock('@/common/platform', () => ({
  getPlatformServices: () => ({
    paths: { isPackaged: () => false, getAppPath: () => null },
    worker: {
      fork: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        postMessage: vi.fn(),
        kill: vi.fn(),
      })),
    },
  }),
}));

vi.mock('@process/utils/shellEnv', () => ({
  getEnhancedEnv: vi.fn(() => ({})),
}));

vi.mock('@process/services/database', () => ({
  getDatabase: vi.fn(() => Promise.resolve(mockDb)),
}));

vi.mock('@process/services/database/export', () => ({
  getDatabase: vi.fn(() => Promise.resolve(mockDb)),
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessChat: { get: vi.fn(() => Promise.resolve([])) },
}));

vi.mock('@process/utils/message', () => ({
  addMessage: vi.fn(),
  addOrUpdateMessage: vi.fn(),
}));

vi.mock('@/common/utils', () => {
  let counter = 0;
  return { uuid: vi.fn(() => `uuid-${++counter}`) };
});

vi.mock('@/renderer/utils/common', () => {
  let counter = 0;
  return { uuid: vi.fn(() => `pipe-${++counter}`) };
});

vi.mock('@process/utils/mainLogger', () => ({
  mainError: vi.fn(),
  mainLog: vi.fn(),
  mainWarn: vi.fn(),
}));

vi.mock('@process/services/cron/cronServiceSingleton', () => ({
  cronService: {
    addJob: vi.fn(async () => ({ id: 'cron-1', name: 'test', enabled: true })),
    removeJob: vi.fn(async () => {}),
    listJobsByConversation: vi.fn(async () => []),
  },
}));

vi.mock('@process/services/cron/CronBusyGuard', () => ({
  cronBusyGuard: {
    setProcessing: vi.fn(),
    isProcessing: vi.fn(() => false),
  },
}));

vi.mock('@/process/task/ConversationTurnCompletionService', () => ({
  ConversationTurnCompletionService: {
    getInstance: vi.fn(() => ({
      notifyPotentialCompletion: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

vi.mock('@process/agent/wcore', () => ({
  WCoreAgent: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    kill: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    approveTool: vi.fn(),
    denyTool: vi.fn(),
    injectConversationHistory: vi.fn().mockResolvedValue(undefined),
    get bootstrap() {
      return Promise.resolve();
    },
  })),
}));

// ── Import under test ──────────────────────────────────────────────

import { WCoreManager } from '@/process/task/WCoreManager';

// ── Helpers ────────────────────────────────────────────────────────

const CONV_ID = 'conv-cu-1';

function createManager(conversationId = CONV_ID): WCoreManager {
  const data = {
    workspace: '/test/workspace',
    model: { name: 'test-provider', useModel: 'test-model', baseUrl: '', platform: 'test' },
    conversation_id: conversationId,
  };
  return new WCoreManager(data as any, data.model as any);
}

function emitEvent(manager: WCoreManager, event: Record<string, unknown>) {
  (manager as any).emit('wcore.message', event);
}

// ── Tests ──────────────────────────────────────────────────────────

describe('GAP-2: WCoreManager Context Usage Persistence', () => {
  let manager: WCoreManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDb.getConversation.mockReturnValue({
      success: true,
      data: { type: 'wcore', extra: { workspace: '/test' } },
    });
    manager = createManager();
    vi.spyOn(manager as any, 'postMessagePromise').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── AC-1: Valid usage data is persisted ───────────────────────────

  describe('AC-1: Valid TokenUsage is persisted to DB', () => {
    it('saves lastTokenUsage on finish with valid usage data', async () => {
      emitEvent(manager, { type: 'start', data: '', msg_id: 'msg-1' });
      emitEvent(manager, { type: 'content', data: 'hello', msg_id: 'msg-1' });
      emitEvent(manager, {
        type: 'finish',
        data: { input_tokens: 1000, output_tokens: 200 },
        msg_id: 'msg-1',
      });

      await vi.advanceTimersByTimeAsync(200);

      expect(mockDb.updateConversation).toHaveBeenCalledWith(
        CONV_ID,
        expect.objectContaining({
          extra: expect.objectContaining({
            lastTokenUsage: expect.objectContaining({
              totalTokens: expect.any(Number),
            }),
          }),
        })
      );
    });
  });

  // ── AC-2: totalTokens = input_tokens + output_tokens ─────────────

  describe('AC-2: totalTokens equals input_tokens + output_tokens', () => {
    it('calculates totalTokens correctly', async () => {
      emitEvent(manager, { type: 'start', data: '', msg_id: 'msg-1' });
      emitEvent(manager, {
        type: 'finish',
        data: { input_tokens: 5000, output_tokens: 800 },
        msg_id: 'msg-1',
      });

      await vi.advanceTimersByTimeAsync(200);

      expect(mockDb.updateConversation).toHaveBeenCalledWith(
        CONV_ID,
        expect.objectContaining({
          extra: expect.objectContaining({
            // Still input + output, and now alongside the figures it was
            // summed from rather than instead of them - see AC-6.
            lastTokenUsage: { totalTokens: 5800, inputTokens: 5000, outputTokens: 800 },
          }),
        })
      );
    });

    it('handles usage with cache tokens', async () => {
      emitEvent(manager, { type: 'start', data: '', msg_id: 'msg-1' });
      emitEvent(manager, {
        type: 'finish',
        data: {
          input_tokens: 3000,
          output_tokens: 500,
          cache_read_tokens: 1000,
          cache_write_tokens: 200,
        },
        msg_id: 'msg-1',
      });

      await vi.advanceTimersByTimeAsync(200);

      // totalTokens is still input + output, not including cache - but the
      // cache figures are kept beside it instead of being thrown away.
      expect(mockDb.updateConversation).toHaveBeenCalledWith(
        CONV_ID,
        expect.objectContaining({
          extra: expect.objectContaining({
            lastTokenUsage: {
              totalTokens: 3500,
              inputTokens: 3000,
              outputTokens: 500,
              cacheReadTokens: 1000,
              cacheWriteTokens: 200,
            },
          }),
        })
      );
    });
  });

  // ── AC-3: No DB write when usage is absent ───────────────────────

  describe('AC-3: No DB write when usage data is absent', () => {
    it('does not save when finish data is empty string', async () => {
      mockDb.updateConversation.mockClear();

      emitEvent(manager, { type: 'start', data: '', msg_id: 'msg-1' });
      emitEvent(manager, { type: 'finish', data: '', msg_id: 'msg-1' });

      await vi.advanceTimersByTimeAsync(200);

      // updateConversation may be called for other reasons (e.g. sendMessage),
      // but not with lastTokenUsage
      const usageCalls = mockDb.updateConversation.mock.calls.filter(
        ([, updates]: [string, any]) => updates?.extra?.lastTokenUsage
      );
      expect(usageCalls).toHaveLength(0);
    });

    it('does not save when finish data is undefined', async () => {
      mockDb.updateConversation.mockClear();

      emitEvent(manager, { type: 'start', data: '', msg_id: 'msg-1' });
      emitEvent(manager, { type: 'finish', data: undefined, msg_id: 'msg-1' });

      await vi.advanceTimersByTimeAsync(200);

      const usageCalls = mockDb.updateConversation.mock.calls.filter(
        ([, updates]: [string, any]) => updates?.extra?.lastTokenUsage
      );
      expect(usageCalls).toHaveLength(0);
    });
  });

  // ── AC-4: DB errors are silently caught ──────────────────────────

  describe('AC-4: DB errors are silently caught', () => {
    it('does not throw when getConversation fails', async () => {
      mockDb.getConversation.mockReturnValue({ success: false });

      emitEvent(manager, { type: 'start', data: '', msg_id: 'msg-1' });
      emitEvent(manager, {
        type: 'finish',
        data: { input_tokens: 100, output_tokens: 50 },
        msg_id: 'msg-1',
      });

      // Should not throw
      await vi.advanceTimersByTimeAsync(200);
    });

    it('does not throw when updateConversation throws', async () => {
      mockDb.updateConversation.mockImplementation(() => {
        throw new Error('DB write failed');
      });

      emitEvent(manager, { type: 'start', data: '', msg_id: 'msg-1' });
      emitEvent(manager, {
        type: 'finish',
        data: { input_tokens: 100, output_tokens: 50 },
        msg_id: 'msg-1',
      });

      // Should not throw
      await vi.advanceTimersByTimeAsync(200);
    });
  });

  // ── AC-5: Fallback finish does not save usage ────────────────────

  describe('AC-5: Fallback finish does not save usage', () => {
    it('does not persist usage on fallback timeout (no usage data)', async () => {
      mockDb.updateConversation.mockClear();

      emitEvent(manager, { type: 'start', data: '', msg_id: 'msg-1' });
      emitEvent(manager, { type: 'content', data: 'data', msg_id: 'msg-1' });

      // Trigger fallback (no finish event)
      await vi.advanceTimersByTimeAsync(15_000);

      const usageCalls = mockDb.updateConversation.mock.calls.filter(
        ([, updates]: [string, any]) => updates?.extra?.lastTokenUsage
      );
      expect(usageCalls).toHaveLength(0);
    });
  });

  // ── AC-6: The record written here must not be narrower than the one
  //          the renderer writes on the very same finish frame ─────────
  //
  // Both processes persist `extra.lastTokenUsage` when a turn finishes: the
  // renderer's `useWCoreMessage` writes all five engine figures, and this
  // manager wrote `{ totalTokens }` alone. The two races - whichever lands
  // second wins the key - so a narrow write here silently strips the four
  // extra figures, and the loss only becomes visible after a restart, when the
  // ring rehydrates from disk and has nothing but the inflated sum to divide.
  //
  // The fix is to make BOTH writes carry the same shape, so the order of the
  // race stops mattering.

  describe('AC-6: persists every figure the engine sent, not just the sum', () => {
    it('writes the wide record the renderer also writes', async () => {
      emitEvent(manager, { type: 'start', data: '', msg_id: 'msg-1' });
      emitEvent(manager, {
        type: 'finish',
        data: {
          input_tokens: 120,
          output_tokens: 40,
          cache_read_tokens: 16,
          cache_write_tokens: 8,
          active_window_percent: 37,
        },
        msg_id: 'msg-1',
      });

      await vi.advanceTimersByTimeAsync(200);

      expect(mockDb.updateConversation).toHaveBeenCalledWith(
        CONV_ID,
        expect.objectContaining({
          extra: expect.objectContaining({
            lastTokenUsage: {
              totalTokens: 160,
              inputTokens: 120,
              outputTokens: 40,
              cacheReadTokens: 16,
              cacheWriteTokens: 8,
              activeWindowPercent: 37,
            },
          }),
        })
      );
    });

    it('records a turn that reported only a window percentage', async () => {
      // `totalTokens` is 0 there, and the old `totalTokens <= 0` gate threw the
      // whole reading away - including the one figure that was measured.
      emitEvent(manager, { type: 'start', data: '', msg_id: 'msg-1' });
      emitEvent(manager, { type: 'finish', data: { active_window_percent: 42 }, msg_id: 'msg-1' });

      await vi.advanceTimersByTimeAsync(200);

      const usageCalls = mockDb.updateConversation.mock.calls.filter(
        ([, updates]: [string, any]) => updates?.extra?.lastTokenUsage
      );
      expect(usageCalls).toHaveLength(1);
      expect(usageCalls[0][1].extra.lastTokenUsage).toEqual({ totalTokens: 0, activeWindowPercent: 42 });
    });

    it('keeps a genuine zero rather than dropping it', async () => {
      // 0% full is a real reading about a fresh window; "absent" is a different
      // claim, and a truthiness filter cannot tell them apart.
      emitEvent(manager, { type: 'start', data: '', msg_id: 'msg-1' });
      emitEvent(manager, {
        type: 'finish',
        data: { input_tokens: 900, output_tokens: 100, cache_read_tokens: 0, active_window_percent: 0 },
        msg_id: 'msg-1',
      });

      await vi.advanceTimersByTimeAsync(200);

      const usageCalls = mockDb.updateConversation.mock.calls.filter(
        ([, updates]: [string, any]) => updates?.extra?.lastTokenUsage
      );
      expect(usageCalls[0][1].extra.lastTokenUsage).toEqual({
        totalTokens: 1000,
        inputTokens: 900,
        outputTokens: 100,
        cacheReadTokens: 0,
        activeWindowPercent: 0,
      });
    });

    it('omits a non-numeric figure instead of persisting NaN', async () => {
      emitEvent(manager, { type: 'start', data: '', msg_id: 'msg-1' });
      emitEvent(manager, {
        type: 'finish',
        data: { input_tokens: 700, output_tokens: 300, cache_read_tokens: 'lots' },
        msg_id: 'msg-1',
      });

      await vi.advanceTimersByTimeAsync(200);

      const usageCalls = mockDb.updateConversation.mock.calls.filter(
        ([, updates]: [string, any]) => updates?.extra?.lastTokenUsage
      );
      const stored = usageCalls[0][1].extra.lastTokenUsage;
      expect(stored.cacheReadTokens).toBeUndefined();
      expect(stored.totalTokens).toBe(1000);
      expect(Number.isNaN(stored.totalTokens)).toBe(false);
    });
  });
});
