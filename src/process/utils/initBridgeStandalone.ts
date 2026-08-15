/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridge initialiser for standalone (no-Electron) mode.
 * Skips Electron-only bridges:
 *   dialogBridge, applicationBridge (partial - core handlers in applicationBridgeCore),
 *   windowControlsBridge, updateBridge, webuiBridge
 * Note: shellBridge is replaced by shellBridgeStandalone (child_process-based).
 */
import { logger } from '@office-ai/platform';
import { agentRegistry } from '@process/agent/AgentRegistry';
import { SqliteChannelRepository } from '@process/services/database/SqliteChannelRepository';
import { SqliteConversationRepository } from '@process/services/database/SqliteConversationRepository';
import { ConversationServiceImpl } from '@process/services/ConversationServiceImpl';
import { workerTaskManager } from '@process/task/workerTaskManagerSingleton';
import { initAcpConversationBridge } from '@process/bridge/conversation/acpConversationBridge';
import { initAuthBridge } from '@process/bridge/model/providers/authBridge';
import { initBedrockBridge } from '@process/bridge/model/providers/bedrockBridge';
import { initChannelBridge } from '@process/bridge/remote/channelBridge';
import { initConversationBridge } from '@process/bridge/conversation/conversationBridge';
import { initDatabaseBridge } from '@process/bridge/knowledge/databaseBridge';
import { initDocumentBridge } from '@process/bridge/media/documentBridge';
import { initExtensionsBridge } from '@process/bridge/engine/extensions/extensionsBridge';
import { initFileWatchBridge } from '@process/bridge/workspace/fileWatchBridge';
import { initGeminiBridge } from '@process/bridge/model/providers/geminiBridge';
import { initGeminiConversationBridge } from '@process/bridge/conversation/geminiConversationBridge';
import { initModelBridge } from '@process/bridge/model/modelBridge';
import { initPreviewHistoryBridge } from '@process/bridge/media/previewHistoryBridge';
import { initPptPreviewBridge } from '@process/bridge/media/pptPreviewBridge';
import { initOfficeWatchBridge } from '@process/bridge/media/officeWatchBridge';
import { initStarOfficeBridge } from '@process/bridge/agent/starOfficeBridge';
import { initApplicationBridgeCore } from '@process/bridge/desktop/applicationBridgeCore';
import { initShellBridgeStandalone } from '@process/bridge/workspace/shellBridgeStandalone';
import { initCronBridge } from '@process/bridge/agent/orchestration/cronBridge';
import { initFsBridge } from '@process/bridge/workspace/fsBridge';
import { initMcpBridge } from '@process/bridge/engine/extensions/mcpBridge';
import { initNotificationBridge } from '@process/bridge/desktop/notificationBridge';
import { initSystemSettingsBridge } from '@process/bridge/desktop/systemSettingsBridge';
import { initTaskBridge } from '@process/bridge/agent/orchestration/taskBridge';
import { initSpeechToTextBridge } from '@process/bridge/media/voice/speechToTextBridge';
import { initHubBridge } from '@process/bridge/engine/extensions/hubBridge';
import { initProjectBridge } from '@process/bridge/workspace/projectBridge';
import { initTeamBridge } from '@process/bridge/agent/orchestration/teamBridge';
import { initSkillsBridge } from '@process/bridge/agent/skillsBridge';
import { SqliteTeamRepository } from '@process/team/repository/SqliteTeamRepository';
import { TeamSessionService } from '@process/team/TeamSessionService';

logger.config({ print: true });

export async function initBridgeStandalone(): Promise<void> {
  const repo = new SqliteConversationRepository();
  const conversationService = new ConversationServiceImpl(repo);
  const channelRepo = new SqliteChannelRepository();

  // Skipped (Electron-only): dialogBridge, applicationBridge (partial - see applicationBridgeCore),
  // windowControlsBridge, updateBridge, webuiBridge

  initApplicationBridgeCore();
  initShellBridgeStandalone();
  initFileWatchBridge();
  initFsBridge();
  initConversationBridge(conversationService, workerTaskManager);
  initGeminiConversationBridge(workerTaskManager);
  initGeminiBridge();
  initBedrockBridge();
  initAcpConversationBridge(workerTaskManager);
  initAuthBridge();
  initModelBridge();
  initPreviewHistoryBridge();
  initDocumentBridge();
  initPptPreviewBridge();
  initOfficeWatchBridge();
  initChannelBridge(channelRepo);
  initDatabaseBridge(repo);
  initExtensionsBridge(repo, workerTaskManager);
  initSystemSettingsBridge();
  initCronBridge();
  initMcpBridge();
  initNotificationBridge();
  initTaskBridge(workerTaskManager);
  initStarOfficeBridge();
  initSpeechToTextBridge();
  initHubBridge();
  initProjectBridge();

  // Team session service: pass the three required deps; ritualScheduler is
  // optional (Standing-Company rituals are a no-op without it, which is fine
  // for headless mode — users aren't installing cron-driven rituals here).
  const teamRepo = new SqliteTeamRepository();
  const teamSessionService = new TeamSessionService(teamRepo, workerTaskManager, conversationService);
  initTeamBridge(teamSessionService);

  initSkillsBridge();

  // Initialize ACP detector to scan for installed CLI agents (claude, codex, etc.)
  // Must mirror Electron's initializeAcpDetector() call in src/index.ts
  try {
    await agentRegistry.initialize();
  } catch (error) {
    console.error('[ACP] Failed to initialize detector in standalone mode:', error);
  }
}
