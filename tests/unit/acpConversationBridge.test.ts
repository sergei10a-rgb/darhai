import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/tmp') } }));

const handlers: Record<string, (...args: any[]) => any> = {};
function makeChannel(name: string) {
  return {
    provider: vi.fn((fn: (...args: any[]) => any) => {
      handlers[name] = fn;
    }),
    emit: vi.fn(),
    invoke: vi.fn(),
  };
}

vi.mock('../../src/common', () => ({
  ipcBridge: {
    acpConversation: {
      checkEnv: makeChannel('checkEnv'),
      detectCliPath: makeChannel('detectCliPath'),
      getAvailableAgents: makeChannel('getAvailableAgents'),
      getLoadErrors: makeChannel('getLoadErrors'),
      refreshCustomAgents: makeChannel('refreshCustomAgents'),
      testCustomAgent: makeChannel('testCustomAgent'),
      checkAgentHealth: makeChannel('checkAgentHealth'),
      getMode: makeChannel('getMode'),
      getModelInfo: makeChannel('getModelInfo'),
      setModel: makeChannel('setModel'),
      setMode: makeChannel('setMode'),
      getConfigOptions: makeChannel('getConfigOptions'),
      setConfigOption: makeChannel('setConfigOption'),
    },
  },
}));

vi.mock('../../src/process/agent/AgentRegistry', () => ({
  agentRegistry: {
    getDetectedAgents: vi.fn(() => []),
    getLoadErrors: vi.fn(() => []),
    // Detection is kicked off fire-and-forget at boot; every renderer-reachable
    // read must await this or it can observe the still-empty snapshot.
    whenReady: vi.fn(async () => {}),
    refreshCustomAgents: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/process/agent/acp/AcpConnection', () => ({
  AcpConnection: vi.fn(function () {
    return {
      connect: vi.fn(async () => {}),
      newSession: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      getConfigOptions: vi.fn(() => []),
      getModels: vi.fn(() => []),
      getInitializeResponse: vi.fn(() => null),
    };
  }),
}));
vi.mock('../../src/process/task/AcpAgentManager', () => ({ default: vi.fn() }));
vi.mock('../../src/process/task/GeminiAgentManager', () => ({ GeminiAgentManager: vi.fn() }));

vi.mock('../../src/process/services/mcpServices/McpService', () => ({
  mcpService: { getSupportedTransportsForAgent: vi.fn(() => []) },
}));

// AgentRegistry is mocked wholesale below, so this module is not actually
// loaded by these tests today. It is kept complete rather than trimmed: the
// registry now calls `resolveWCoreBinary`, and a partial mock would turn any
// future un-mocking of the registry into "resolveWCoreBinary is not a function"
// rather than a readable failure.
vi.mock('../../src/process/agent/wcore/binaryResolver', () => ({
  detectWCore: vi.fn(() => ({ available: false, path: null })),
  resolveWCoreBinary: vi.fn(() => null),
}));

vi.mock('../../src/process/utils/mainLogger', () => ({
  mainLog: vi.fn(),
  mainWarn: vi.fn(),
}));

import { initAcpConversationBridge } from '../../src/process/bridge/conversation/acpConversationBridge';
import type { IWorkerTaskManager } from '../../src/process/task/IWorkerTaskManager';

function makeTaskManager(overrides?: Partial<IWorkerTaskManager>): IWorkerTaskManager {
  return {
    getTask: vi.fn(() => undefined),
    getOrBuildTask: vi.fn(async () => {
      throw new Error('not found');
    }),
    addTask: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    listTasks: vi.fn(() => []),
    ...overrides,
  };
}

describe('acpConversationBridge', () => {
  let taskManager: IWorkerTaskManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    taskManager = makeTaskManager();
    const { agentRegistry } = await import('../../src/process/agent/AgentRegistry');
    vi.mocked(agentRegistry.getDetectedAgents).mockReturnValue([]);
    // clearAllMocks drops call history but keeps implementations, so restore the
    // default "detection already finished" behaviour for every test.
    vi.mocked(agentRegistry.whenReady).mockImplementation(async () => {});
    initAcpConversationBridge(taskManager);
  });

  // --- getMode ---

  it('returns { initialized: false } when no task exists for the conversation', async () => {
    vi.mocked(taskManager.getTask).mockReturnValue(undefined);

    const result = await handlers['getMode']({ conversationId: 'missing' });

    expect(result).toEqual({ success: true, data: { mode: 'default', initialized: false } });
  });

  it('uses injected taskManager to look up task by conversation id', async () => {
    vi.mocked(taskManager.getTask).mockReturnValue(undefined);

    await handlers['getMode']({ conversationId: 'c1' });

    expect(taskManager.getTask).toHaveBeenCalledWith('c1');
  });

  // --- refreshCustomAgents ---

  it('refreshCustomAgents delegates to agentRegistry and returns success', async () => {
    const { agentRegistry } = await import('../../src/process/agent/AgentRegistry');
    const result = await handlers['refreshCustomAgents']();
    expect(result).toEqual({ success: true });
    expect(agentRegistry.refreshCustomAgents).toHaveBeenCalledTimes(1);
  });

  it('refreshCustomAgents can be called multiple times', async () => {
    const { agentRegistry } = await import('../../src/process/agent/AgentRegistry');
    await handlers['refreshCustomAgents']();
    const result = await handlers['refreshCustomAgents']();
    expect(result).toEqual({ success: true });
    expect(agentRegistry.refreshCustomAgents).toHaveBeenCalledTimes(2);
  });

  // --- getAvailableAgents ---

  it('getAvailableAgents returns enriched agent list', async () => {
    const { agentRegistry } = await import('../../src/process/agent/AgentRegistry');
    vi.mocked(agentRegistry.getDetectedAgents).mockReturnValue([
      { backend: 'claude', name: 'Claude', cliPath: '/usr/bin/claude' },
    ] as any);

    const { mcpService } = await import('../../src/process/services/mcpServices/McpService');
    vi.mocked(mcpService.getSupportedTransportsForAgent).mockReturnValue(['stdio'] as any);

    const result = await handlers['getAvailableAgents']();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].supportedTransports).toEqual(['stdio']);
  });

  it('getAvailableAgents waits for detection before reading the registry', async () => {
    // The registry snapshot is empty until the first detection pass merges into
    // it. Reading it without waiting is how the agent picker ended up with zero
    // pills, so the ordering - not just the result - is what this pins.
    const { agentRegistry } = await import('../../src/process/agent/AgentRegistry');
    const order: string[] = [];
    let releaseDetection: (() => void) | undefined;
    vi.mocked(agentRegistry.whenReady).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push('whenReady');
          releaseDetection = resolve;
        })
    );
    vi.mocked(agentRegistry.getDetectedAgents).mockImplementation(() => {
      order.push('getDetectedAgents');
      return [{ backend: 'claude', name: 'Claude' }] as never;
    });

    const pending = handlers['getAvailableAgents']();
    await Promise.resolve();
    expect(order, 'provider read the registry before detection finished').toEqual(['whenReady']);

    releaseDetection?.();
    const result = await pending;

    expect(order).toEqual(['whenReady', 'getDetectedAgents']);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
  });

  it('getAvailableAgents forwards available and version across the IPC seam', async () => {
    // The provider maps an EXPLICIT field list, and `available`/`version` were
    // both missing from it - so the renderer could only infer availability from
    // presence in the array, and the engine's semver never arrived at all.
    const { agentRegistry } = await import('../../src/process/agent/AgentRegistry');
    vi.mocked(agentRegistry.getDetectedAgents).mockReturnValue([
      {
        id: 'wcore',
        backend: 'wcore',
        name: 'Darhai Core',
        kind: 'wcore',
        available: true,
        cliPath: '/opt/darhai/wayland-core',
        version: '0.12.26',
      },
    ]);

    const result = await handlers['getAvailableAgents']();

    expect(result.success).toBe(true);
    expect(result.data[0].available).toBe(true);
    expect(result.data[0].version).toBe('0.12.26');
    expect(result.data[0].cliPath).toBe('/opt/darhai/wayland-core');
  });

  it('getAvailableAgents forwards available: false instead of dropping the entry', async () => {
    const { agentRegistry } = await import('../../src/process/agent/AgentRegistry');
    vi.mocked(agentRegistry.getDetectedAgents).mockReturnValue([
      { id: 'wcore', backend: 'wcore', name: 'Darhai Core', kind: 'wcore', available: false },
    ]);

    const result = await handlers['getAvailableAgents']();

    // Presence still means "Darhai ships this backend"; `available` carries
    // whether it can be used. A caller must be able to tell them apart.
    expect(result.data).toHaveLength(1);
    expect(result.data[0].available).toBe(false);
    expect(result.data[0].version).toBeUndefined();
  });

  it('getAvailableAgents returns error when registry throws', async () => {
    const { agentRegistry } = await import('../../src/process/agent/AgentRegistry');
    vi.mocked(agentRegistry.getDetectedAgents).mockImplementation(() => {
      throw new Error('detection failed');
    });

    const result = await handlers['getAvailableAgents']();
    expect(result).toEqual({ success: false, msg: 'detection failed' });
  });
});
