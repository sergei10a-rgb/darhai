/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The single entry point that wires every IPC bridge into the main process.
 * The individual bridges live in the nine responsibility directories imported
 * below; this file only decides that they are initialized and in what order.
 *
 * Headroom: this directory is at the 10-child cap - nine responsibility
 * directories plus this barrel - so it has none. A new bridge joins one of the
 * nine; a genuinely new top-level responsibility cannot be added until one of
 * them is split, and `tests/unit/process/bridge/bridgeDirectoryLimit.test.ts`
 * fails the build rather than letting a tenth directory appear here.
 */

import { agentRegistry } from '@process/agent/AgentRegistry';
import type { IChannelRepository } from '@process/services/database/IChannelRepository';
import type { IConversationRepository } from '@process/services/database/IConversationRepository';
import type { IConversationService } from '@process/services/IConversationService';
import type { IWorkerTaskManager } from '@process/task/IWorkerTaskManager';
import {
  initAcpConversationBridge,
  initCompressionBridge,
  initConstitutionBridge,
  initConversationBridge,
  initGeminiConversationBridge,
  initKickoffBridge,
  initPendingSendBridge,
  initToolConfirmationBridge,
} from './conversation';
import { initOnboardingBridge, initRemoteAgentBridge, initSkillsBridge, initStarOfficeBridge } from './agent';
import { initCronBridge, initMissionControlBridge, initTaskBridge, initTeamBridge } from './agent/orchestration';
import {
  initCompareBridge,
  initFusionBridge,
  initModelBridge,
  initOmnirouteGatewayBridge,
  initRoutingBridge,
} from './model';
import { initAuthBridge, initBedrockBridge, initGeminiBridge } from './model/providers';
import {
  initCookbookBridge,
  initHwfitBridge,
  initLlamaRuntimeBridge,
  initWcoreConfigBridge,
  initWcoreDiagnosticsBridge,
  initWcoreEngineBridge,
} from './engine';
import {
  initEccBridge,
  initExtensionsBridge,
  initHookGuardBridge,
  initHubBridge,
  initIjfwBridge,
  initIjfwDropBridge,
  initMcpBridge,
} from './engine/extensions';
import {
  initFileWatchBridge,
  initFsBridge,
  initProjectBridge,
  initShellBridge,
  initWorkspaceSnapshotBridge,
} from './workspace';
import {
  initDatabaseBridge,
  initImportBridge,
  initMemoryArchiveBridge,
  initPromotionSweep,
  initResearchBridge,
  initWikiBridge,
} from './knowledge';
import {
  initCalendarBridge,
  initDocumentsBridge,
  initEmailTriageBridge,
  initLocalUserBridge,
  initNoteBridge,
} from './knowledge/records';
import {
  initAmbientBridge,
  initApplicationBridge,
  initDialogBridge,
  initNotificationBridge,
  initSystemSettingsBridge,
  initUpdateBridge,
  initWindowControlsBridge,
} from './desktop';
import { initDocumentBridge, initOfficeWatchBridge, initPptPreviewBridge, initPreviewHistoryBridge } from './media';
import { initSpeechToTextBridge, initVoiceAssetBridge, initVoiceSynthBridge } from './media/voice';
import { initChannelBridge, initWebuiBridge, initWeixinLoginBridge } from './remote';
import { startWikiAutoSync } from '@process/services/wiki/wikiAutoSync';
import { initStorageBridge } from '@process/storage/storageIpc';
import { initNicknamesBridge } from '@process/storage/nicknamesIpc';
import { initSyncIpc } from '@process/sync/syncIpc';
import type { TeamSessionService } from '@process/team/TeamSessionService';
import { initModelRegistryIpc } from '@process/providers/ipc/modelRegistryIpc';
import { initWcoreToolKeyIpc } from '@process/agent/wcore/toolKeyIpc';

export interface BridgeDependencies {
  conversationService: IConversationService;
  conversationRepo: IConversationRepository;
  workerTaskManager: IWorkerTaskManager;
  channelRepo: IChannelRepository;
  teamSessionService: TeamSessionService;
}

/**
 * Initialize all IPC bridge modules
 */
export function initAllBridges(deps: BridgeDependencies): void {
  initDialogBridge();
  initShellBridge();
  initFsBridge();
  initFileWatchBridge();
  initConversationBridge(deps.conversationService, deps.workerTaskManager, deps.teamSessionService);
  initApplicationBridge(deps.workerTaskManager);
  initGeminiConversationBridge(deps.workerTaskManager);
  // extra Gemini helper bridges (subscription detection, etc.) must be available after the conversation bridge is initialized / extra helpers after core bridges
  initGeminiBridge();
  initBedrockBridge();
  initAcpConversationBridge(deps.workerTaskManager);
  initAuthBridge();
  initModelBridge();
  initMcpBridge();
  initPreviewHistoryBridge();
  initDocumentBridge();
  initPptPreviewBridge();
  initOfficeWatchBridge();
  initWindowControlsBridge();
  initUpdateBridge();
  initWebuiBridge();
  initChannelBridge(deps.channelRepo);
  initDatabaseBridge(deps.conversationRepo);
  initExtensionsBridge(deps.conversationRepo, deps.workerTaskManager);
  initCronBridge();
  initProjectBridge();
  initKickoffBridge();
  initSystemSettingsBridge();
  initIjfwBridge();
  initIjfwDropBridge();
  initEccBridge();
  initHookGuardBridge();
  initToolConfirmationBridge();
  initCompressionBridge();
  initRoutingBridge();
  initOmnirouteGatewayBridge();
  initMemoryArchiveBridge();
  initPromotionSweep();
  initWikiBridge();
  startWikiAutoSync();
  initImportBridge();
  initAmbientBridge();
  initNotificationBridge();
  initTaskBridge(deps.workerTaskManager);
  initStarOfficeBridge();
  initSpeechToTextBridge();
  initVoiceAssetBridge();
  initVoiceSynthBridge();
  initSkillsBridge();
  initWeixinLoginBridge();
  initWorkspaceSnapshotBridge();
  initRemoteAgentBridge();
  initHubBridge();
  initTeamBridge(deps.teamSessionService);
  initMissionControlBridge(deps.teamSessionService);
  initHwfitBridge();
  initCookbookBridge();
  // After cookbook: the runtime bridge is what makes cookbook's llama-server
  // path reachable on a machine where the user installed only Darhai.
  initLlamaRuntimeBridge();
  initCompareBridge();
  initFusionBridge();
  initLocalUserBridge();
  initNoteBridge();
  initCalendarBridge();
  initDocumentsBridge();
  initResearchBridge();
  initEmailTriageBridge();
  // A DB / migration failure during registration would otherwise become an
  // unhandled rejection and the `modelRegistry` namespace would silently never
  // register - log it so the failure is at least visible.
  void initModelRegistryIpc().catch((error) => {
    console.error('[modelRegistry] Failed to initialize IPC:', error);
  });
  initWcoreToolKeyIpc();
  initWcoreConfigBridge();
  initWcoreEngineBridge();
  initWcoreDiagnosticsBridge(deps.workerTaskManager);
  initPendingSendBridge();
  initStorageBridge();
  initNicknamesBridge();
  initSyncIpc();
  initConstitutionBridge();
  initOnboardingBridge();
}

/**
 * Initialize the ACP detector
 */
export async function initializeAcpDetector(): Promise<void> {
  try {
    await agentRegistry.initialize();
  } catch (error) {
    console.error('[ACP] Failed to initialize detector:', error);
  }
}

// Export individual init functions for standalone use

export {
  initMemoryArchiveBridge,
  initPromotionSweep,
  initAcpConversationBridge,
  initApplicationBridge,
  initAuthBridge,
  initBedrockBridge,
  initChannelBridge,
  initConversationBridge,
  initCronBridge,
  initProjectBridge,
  initDatabaseBridge,
  initDialogBridge,
  initDocumentBridge,
  initExtensionsBridge,
  initFsBridge,
  initGeminiBridge,
  initGeminiConversationBridge,
  initKickoffBridge,
  initMcpBridge,
  initModelBridge,
  initNotificationBridge,
  initOfficeWatchBridge,
  initPptPreviewBridge,
  initPreviewHistoryBridge,
  initShellBridge,
  initSpeechToTextBridge,
  initVoiceAssetBridge,
  initVoiceSynthBridge,
  initSkillsBridge,
  initStarOfficeBridge,
  initSystemSettingsBridge,
  initAmbientBridge,
  initTaskBridge,
  initUpdateBridge,
  initWebuiBridge,
  initConstitutionBridge,
  initOnboardingBridge,
  initRemoteAgentBridge,
  initHubBridge,
  initTeamBridge,
  initHwfitBridge,
  initCookbookBridge,
  initLlamaRuntimeBridge,
  initCompareBridge,
  initFusionBridge,
  initLocalUserBridge,
  initNoteBridge,
  initCalendarBridge,
  initDocumentsBridge,
  initResearchBridge,
  initEmailTriageBridge,
  initWindowControlsBridge,
  initWeixinLoginBridge,
  initWorkspaceSnapshotBridge,
  initIjfwBridge,
  initIjfwDropBridge,
  initEccBridge,
  initHookGuardBridge,
  initToolConfirmationBridge,
  initCompressionBridge,
  initRoutingBridge,
  initOmnirouteGatewayBridge,
  initWikiBridge,
  initImportBridge,
};
export { initModelRegistryIpc } from '@process/providers/ipc/modelRegistryIpc';
export { disposeAllSnapshots } from './workspace/workspaceSnapshotBridge';
export { disposeAllTeamSessions } from './agent/orchestration/teamBridge';
// Export window-control utility functions
export { registerWindowMaximizeListeners } from './desktop/windowControlsBridge';
