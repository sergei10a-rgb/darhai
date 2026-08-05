// tests/integration/process/acp/session/AcpSession.prompt.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcpSession } from '@process/acp/session/AcpSession';
import type { AcpClient, ClientFactory } from '@process/acp/infra/IAcpClient';
import type { AgentConfig, SessionCallbacks, SessionStatus } from '@process/acp/types';
import type { SessionOptions } from '@process/acp/session/AcpSession';

function createMockCallbacks(): SessionCallbacks {
  return {
    onMessage: vi.fn(),
    onSessionId: vi.fn(),
    onStatusChange: vi.fn(),
    onConfigUpdate: vi.fn(),
    onModelUpdate: vi.fn(),
    onModeUpdate: vi.fn(),
    onContextUsage: vi.fn(),
    onPermissionRequest: vi.fn(),
    onSignal: vi.fn(),
  };
}

function createMockClient(): AcpClient {
  return {
    start: vi.fn().mockResolvedValue({ protocolVersion: '0.1', capabilities: {} }),
    createSession: vi.fn().mockResolvedValue({
      sessionId: 'sess-1',
      currentModelId: 'claude-3',
      availableModels: [],
      currentModeId: 'code',
      availableModes: [],
      configOptions: [],
    }),
    loadSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1' }),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    extMethod: vi.fn().mockResolvedValue({}),
    authenticate: vi.fn().mockResolvedValue({}),
    lifecycleSnapshot: { pid: null, running: false, lastExit: null },
    onDisconnect: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const baseConfig: AgentConfig = {
  agentBackend: 'test',
  agentSource: 'builtin',
  agentId: 'builtin:test',
  cwd: '/tmp',
  command: '/usr/bin/test-agent',
  args: ['--stdio'],
};

describe('AcpSession prompt flow', () => {
  let callbacks: SessionCallbacks;
  let client: AcpClient;
  let clientFactory: ClientFactory;

  beforeEach(() => {
    callbacks = createMockCallbacks();
    client = createMockClient();
    clientFactory = { create: vi.fn(() => client) };
  });

  async function startSession() {
    const session = new AcpSession(baseConfig, clientFactory, callbacks);
    session.start();
    await vi.waitFor(() => expect(session.status).toBe('active'));
    return session;
  }

  it('sendMessage triggers prompt directly (INV-S-02)', async () => {
    const session = await startSession();
    session.sendMessage('hello');
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
    expect(session.status).toBe('active');
  });

  it('sendMessage throws in idle state', async () => {
    const session = new AcpSession(baseConfig, clientFactory, callbacks);
    await expect(session.sendMessage('hello')).rejects.toThrow(/Cannot send in idle state/);
  });

  it('sendMessage from suspended triggers resume (T16)', async () => {
    const session = await startSession();
    await session.suspend();
    expect(session.status).toBe('suspended');
    session.sendMessage('after suspend');
    await vi.waitFor(() => expect(['resuming', 'active', 'prompting'].includes(session.status)).toBe(true));
  });

  /**
   * Typing while the agent is still working is the most ordinary thing a person
   * does, and it used to throw INVALID_STATE - which the layer above turned
   * into a failed send. The words were simply gone, with nothing in the
   * transcript to show they had ever been typed. The single pending slot lost
   * them a second way: a second queued message overwrote the first.
   */
  describe('messages sent mid-turn', () => {
    /** Hold the first prompt open so the session stays in `prompting`. */
    function prompterThatHangs() {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      client.prompt = vi.fn(async () => {
        calls += 1;
        if (calls === 1) await held;
        return { stopReason: 'end_turn' as const };
      });
      return { release, promptMock: () => client.prompt as ReturnType<typeof vi.fn> };
    }

    it('queues a follow-up instead of throwing it away', async () => {
      const session = await startSession();
      const { release, promptMock } = prompterThatHangs();

      session.sendMessage('first');
      await vi.waitFor(() => expect(session.status).toBe('prompting'));

      await expect(session.sendMessage('while you were working')).resolves.toBeUndefined();

      release();
      await vi.waitFor(() => expect(promptMock()).toHaveBeenCalledTimes(2));
    });

    it('keeps every queued message, in the order they were typed', async () => {
      // The single slot silently dropped all but the last one.
      const session = await startSession();
      const { release, promptMock } = prompterThatHangs();

      session.sendMessage('first');
      await vi.waitFor(() => expect(session.status).toBe('prompting'));
      await session.sendMessage('second');
      await session.sendMessage('third');

      release();
      await vi.waitFor(() => expect(promptMock()).toHaveBeenCalledTimes(3));

      const sentText = promptMock().mock.calls.map((call) => JSON.stringify(call[1]));
      expect(sentText[1]).toContain('second');
      expect(sentText[2]).toContain('third');
    });

    it('sends one turn at a time, never two prompts at once', async () => {
      // Two concurrent prompts on one session is a protocol error, not a
      // faster reply.
      const session = await startSession();
      const { release, promptMock } = prompterThatHangs();

      session.sendMessage('first');
      await vi.waitFor(() => expect(session.status).toBe('prompting'));
      await session.sendMessage('second');
      await session.sendMessage('third');

      expect(promptMock()).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(promptMock()).toHaveBeenCalledTimes(3));
    });

    it('still refuses to send with no session at all', async () => {
      const session = new AcpSession(baseConfig, clientFactory, callbacks);
      await expect(session.sendMessage('hello')).rejects.toThrow(/Cannot send in idle state/);
    });
  });
});
