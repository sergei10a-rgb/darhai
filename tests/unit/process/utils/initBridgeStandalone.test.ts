import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initApplicationBridgeCore: vi.fn(),
  initShellBridgeStandalone: vi.fn(),
  initFileWatchBridge: vi.fn(),
  initFsBridge: vi.fn(),
  initConversationBridge: vi.fn(),
  initGeminiConversationBridge: vi.fn(),
  initGeminiBridge: vi.fn(),
  initBedrockBridge: vi.fn(),
  initAcpConversationBridge: vi.fn(),
  initAuthBridge: vi.fn(),
  initModelBridge: vi.fn(),
  initPreviewHistoryBridge: vi.fn(),
  initDocumentBridge: vi.fn(),
  initPptPreviewBridge: vi.fn(),
  initOfficeWatchBridge: vi.fn(),
  initChannelBridge: vi.fn(),
  initDatabaseBridge: vi.fn(),
  initExtensionsBridge: vi.fn(),
  initSystemSettingsBridge: vi.fn(),
  initCronBridge: vi.fn(),
  initMcpBridge: vi.fn(),
  initNotificationBridge: vi.fn(),
  initTaskBridge: vi.fn(),
  initStarOfficeBridge: vi.fn(),
  initSpeechToTextBridge: vi.fn(),
  initHubBridge: vi.fn(),
  initProjectBridge: vi.fn(),
  initTeamBridge: vi.fn(),
  initSkillsBridge: vi.fn(),
  initializeRegistry: vi.fn(async () => {}),
  loggerConfig: vi.fn(),
}));

vi.mock('@office-ai/platform', () => ({
  logger: {
    config: (...args: unknown[]) => mocks.loggerConfig(...args),
  },
  // C1: any import that reaches @/common -> ipcBridge calls
  // buildProvider/buildEmitter through the allowlist wrapper at module load.
  // These stubs make those calls inert during the unit test.
  bridge: {
    buildProvider: vi.fn(() => ({ provider: vi.fn(), invoke: vi.fn() })),
    buildEmitter: vi.fn(() => ({ emit: vi.fn(), on: vi.fn() })),
  },
  storage: {
    buildStorage: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
      clear: vi.fn(),
    })),
  },
}));

vi.mock('@process/agent/AgentRegistry', () => ({
  agentRegistry: {
    initialize: (...args: unknown[]) => mocks.initializeRegistry(...args),
  },
}));

vi.mock('@process/services/database/SqliteChannelRepository', () => ({
  SqliteChannelRepository: vi.fn(),
}));

vi.mock('@process/services/database/SqliteConversationRepository', () => ({
  SqliteConversationRepository: vi.fn(),
}));

vi.mock('@process/services/ConversationServiceImpl', () => ({
  ConversationServiceImpl: vi.fn(),
}));

vi.mock('@process/task/workerTaskManagerSingleton', () => ({
  workerTaskManager: {},
}));

vi.mock('@process/bridge/desktop/applicationBridgeCore', () => ({
  initApplicationBridgeCore: (...args: unknown[]) => mocks.initApplicationBridgeCore(...args),
}));
vi.mock('@process/bridge/workspace/shellBridgeStandalone', () => ({
  initShellBridgeStandalone: (...args: unknown[]) => mocks.initShellBridgeStandalone(...args),
}));
vi.mock('@process/bridge/workspace/fileWatchBridge', () => ({
  initFileWatchBridge: (...args: unknown[]) => mocks.initFileWatchBridge(...args),
}));
vi.mock('@process/bridge/workspace/fsBridge', () => ({
  initFsBridge: (...args: unknown[]) => mocks.initFsBridge(...args),
}));
vi.mock('@process/bridge/conversation/conversationBridge', () => ({
  initConversationBridge: (...args: unknown[]) => mocks.initConversationBridge(...args),
}));
vi.mock('@process/bridge/conversation/geminiConversationBridge', () => ({
  initGeminiConversationBridge: (...args: unknown[]) => mocks.initGeminiConversationBridge(...args),
}));
vi.mock('@process/bridge/model/providers/geminiBridge', () => ({
  initGeminiBridge: (...args: unknown[]) => mocks.initGeminiBridge(...args),
}));
vi.mock('@process/bridge/model/providers/bedrockBridge', () => ({
  initBedrockBridge: (...args: unknown[]) => mocks.initBedrockBridge(...args),
}));
vi.mock('@process/bridge/conversation/acpConversationBridge', () => ({
  initAcpConversationBridge: (...args: unknown[]) => mocks.initAcpConversationBridge(...args),
}));
vi.mock('@process/bridge/model/providers/authBridge', () => ({
  initAuthBridge: (...args: unknown[]) => mocks.initAuthBridge(...args),
}));
vi.mock('@process/bridge/model/modelBridge', () => ({
  initModelBridge: (...args: unknown[]) => mocks.initModelBridge(...args),
}));
vi.mock('@process/bridge/media/previewHistoryBridge', () => ({
  initPreviewHistoryBridge: (...args: unknown[]) => mocks.initPreviewHistoryBridge(...args),
}));
vi.mock('@process/bridge/media/documentBridge', () => ({
  initDocumentBridge: (...args: unknown[]) => mocks.initDocumentBridge(...args),
}));
vi.mock('@process/bridge/media/pptPreviewBridge', () => ({
  initPptPreviewBridge: (...args: unknown[]) => mocks.initPptPreviewBridge(...args),
}));
vi.mock('@process/bridge/media/officeWatchBridge', () => ({
  initOfficeWatchBridge: (...args: unknown[]) => mocks.initOfficeWatchBridge(...args),
}));
vi.mock('@process/bridge/remote/channelBridge', () => ({
  initChannelBridge: (...args: unknown[]) => mocks.initChannelBridge(...args),
}));
vi.mock('@process/bridge/knowledge/databaseBridge', () => ({
  initDatabaseBridge: (...args: unknown[]) => mocks.initDatabaseBridge(...args),
}));
vi.mock('@process/bridge/engine/extensions/extensionsBridge', () => ({
  initExtensionsBridge: (...args: unknown[]) => mocks.initExtensionsBridge(...args),
}));
vi.mock('@process/bridge/desktop/systemSettingsBridge', () => ({
  initSystemSettingsBridge: (...args: unknown[]) => mocks.initSystemSettingsBridge(...args),
}));
vi.mock('@process/bridge/agent/orchestration/cronBridge', () => ({
  initCronBridge: (...args: unknown[]) => mocks.initCronBridge(...args),
}));
vi.mock('@process/bridge/engine/extensions/mcpBridge', () => ({
  initMcpBridge: (...args: unknown[]) => mocks.initMcpBridge(...args),
}));
vi.mock('@process/bridge/desktop/notificationBridge', () => ({
  initNotificationBridge: (...args: unknown[]) => mocks.initNotificationBridge(...args),
}));
vi.mock('@process/bridge/agent/orchestration/taskBridge', () => ({
  initTaskBridge: (...args: unknown[]) => mocks.initTaskBridge(...args),
}));
vi.mock('@process/bridge/agent/starOfficeBridge', () => ({
  initStarOfficeBridge: (...args: unknown[]) => mocks.initStarOfficeBridge(...args),
}));
vi.mock('@process/bridge/media/voice/speechToTextBridge', () => ({
  initSpeechToTextBridge: (...args: unknown[]) => mocks.initSpeechToTextBridge(...args),
}));
vi.mock('@process/bridge/engine/extensions/hubBridge', () => ({
  initHubBridge: (...args: unknown[]) => mocks.initHubBridge(...args),
}));
vi.mock('@process/bridge/workspace/projectBridge', () => ({
  initProjectBridge: (...args: unknown[]) => mocks.initProjectBridge(...args),
}));
vi.mock('@process/bridge/agent/orchestration/teamBridge', () => ({
  initTeamBridge: (...args: unknown[]) => mocks.initTeamBridge(...args),
}));
vi.mock('@process/bridge/agent/skillsBridge', () => ({
  initSkillsBridge: (...args: unknown[]) => mocks.initSkillsBridge(...args),
}));
vi.mock('@process/team/repository/SqliteTeamRepository', () => ({
  SqliteTeamRepository: vi.fn(),
}));
vi.mock('@process/team/TeamSessionService', () => ({
  TeamSessionService: vi.fn(),
}));

describe('initBridgeStandalone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the hub bridge and initializes ACP detection', async () => {
    const mod = await import('../../../../src/process/utils/initBridgeStandalone');

    await mod.initBridgeStandalone();

    expect(mocks.initHubBridge).toHaveBeenCalledTimes(1);
    expect(mocks.initializeRegistry).toHaveBeenCalledTimes(1);
  });
});
