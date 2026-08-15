/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { agentRegistry } from '@process/agent/AgentRegistry';
import { isAgentKind } from '@/common/types/detectedAgent';
import type { IWorkerTaskManager } from '@process/task/IWorkerTaskManager';
import AcpAgentManager from '@process/task/AcpAgentManager';
import { GeminiAgentManager } from '@process/task/GeminiAgentManager';
import { WCoreManager } from '@process/task/WCoreManager';
import { mcpService } from '@/process/services/mcpServices/McpService';
import { ipcBridge } from '@/common';
import { checkAgentHealth } from '../agent/checkAgentHealth';

export function initAcpConversationBridge(workerTaskManager: IWorkerTaskManager): void {
  // Debug provider to check environment variables
  ipcBridge.acpConversation.checkEnv.provider(() => {
    return Promise.resolve({
      env: {
        GEMINI_API_KEY: process.env.GEMINI_API_KEY ? '[SET]' : '[NOT SET]',
        GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT ? '[SET]' : '[NOT SET]',
        NODE_ENV: process.env.NODE_ENV || '[NOT SET]',
      },
    });
  });

  ipcBridge.acpConversation.detectCliPath.provider(async ({ backend }) => {
    await agentRegistry.whenReady();
    const agents = agentRegistry.getDetectedAgents();
    const agent = agents.find((a) => isAgentKind(a, 'acp') && a.backend === backend);

    if (agent && isAgentKind(agent, 'acp') && agent.cliPath) {
      return { success: true, data: { path: agent.cliPath } };
    }

    return {
      success: false,
      msg: `${backend} CLI not found. Please install it and ensure it's accessible.`,
    };
  });

  // Get all detected execution engines, enriched with MCP transport support info.
  //
  // AUDIT: this used to read the registry snapshot synchronously. Detection is
  // started fire-and-forget at boot, so the renderer's first query (~300ms after
  // mount) regularly won the race and got `[]` back - which SWR then cached,
  // leaving the agent picker permanently empty. Awaiting `whenReady()` makes the
  // first answer the real one.
  ipcBridge.acpConversation.getAvailableAgents.provider(async () => {
    try {
      await agentRegistry.whenReady();
      const agents = agentRegistry.getDetectedAgents();
      const enriched = agents.map((agent) => ({
        ...agent,
        supportedTransports: mcpService.getSupportedTransportsForAgent(agent),
      }));

      // Map to the IPC bridge response shape explicitly.
      //
      // `available` and `version` used to be dropped here, so the renderer could
      // only infer availability from PRESENCE in this list. The live consumer
      // that got that wrong is the Agents page at `/settings/agents`
      // (renderer/pages/settings/AgentSettings), whose Darhai Core card showed a
      // green "Active" badge derived from `Boolean(find(backend === 'wcore'))` -
      // always true, because Darhai always ships the backend. It now reads
      // `available`. (The older WCoreSettings page had the same bug, but it has
      // been unrouted since `/settings/wcore` started redirecting to
      // `/settings/wcore-config`, so nothing user-visible came from it.)
      //
      // Presence still means "Darhai ships this backend" (unchanged, and several
      // callers depend on it); `available` now carries whether it can actually
      // be used. See the `available` contract on the bridge type for what each
      // producer means by it.
      const data = enriched.map((agent) => ({
        backend: agent.backend,
        name: agent.name,
        kind: agent.kind,
        available: agent.available,
        version: 'version' in agent ? (agent.version as string | undefined) : undefined,
        cliPath: 'cliPath' in agent ? (agent.cliPath as string | undefined) : undefined,
        supportedTransports: agent.supportedTransports,
        isExtension: 'isExtension' in agent ? (agent.isExtension as boolean | undefined) : undefined,
        extensionName: 'extensionName' in agent ? (agent.extensionName as string | undefined) : undefined,
        isPreset: 'isPreset' in agent ? (agent.isPreset as boolean | undefined) : undefined,
        customAgentId: 'customAgentId' in agent ? (agent.customAgentId as string | undefined) : undefined,
      }));
      return { success: true as const, data };
    } catch (error) {
      return {
        success: false as const,
        msg: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // AUDIT-05 F19: surface AgentRegistry sub-detector load failures (e.g.
  // remote agent DB read errors) so the UI can show "remote agents failed
  // to load: <reason>" instead of silently rendering an empty list.
  ipcBridge.acpConversation.getLoadErrors.provider(async () => {
    try {
      // Load errors are only populated by a detection pass, so reading them
      // before one has run reports "no failures" for a registry that has not
      // yet tried. Same wait as getAvailableAgents, for the same reason.
      await agentRegistry.whenReady();
      return { success: true as const, data: agentRegistry.getLoadErrors() };
    } catch (error) {
      return {
        success: false as const,
        msg: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Refresh custom ACP agents after the user adds/edits/deletes one in Settings.
  ipcBridge.acpConversation.refreshCustomAgents.provider(async () => {
    await agentRegistry.refreshCustomAgents();
    return { success: true };
  });

  // Test custom agent connection - validates CLI exists and ACP handshake works
  ipcBridge.acpConversation.testCustomAgent.provider(async (params) => {
    const { testCustomAgentConnection } = await import('../agent/testCustomAgentConnection');
    return testCustomAgentConnection(params);
  });

  // Check agent health by sending a real test message. Bounded by a wall-clock
  // budget so a stalled backend reports a timeout instead of leaving the IPC
  // promise pending forever - see checkAgentHealth.ts.
  ipcBridge.acpConversation.checkAgentHealth.provider(({ backend }) => checkAgentHealth(backend));

  ipcBridge.acpConversation.getMode.provider(({ conversationId }) => {
    const task = workerTaskManager.getTask(conversationId);
    if (
      !task ||
      !(task instanceof AcpAgentManager || task instanceof GeminiAgentManager || task instanceof WCoreManager)
    ) {
      return Promise.resolve({
        success: true,
        data: { mode: 'default', initialized: false },
      });
    }
    return Promise.resolve({ success: true, data: task.getMode() });
  });

  ipcBridge.acpConversation.getModelInfo.provider(({ conversationId }) => {
    const task = workerTaskManager.getTask(conversationId);
    if (!task || !(task instanceof AcpAgentManager)) {
      return Promise.resolve({ success: true, data: { modelInfo: null } });
    }
    return Promise.resolve({
      success: true,
      data: { modelInfo: task.getModelInfo() },
    });
  });

  // Set model for ACP agents
  ipcBridge.acpConversation.setModel.provider(async ({ conversationId, modelId }) => {
    try {
      const task = await workerTaskManager.getOrBuildTask(conversationId);
      if (!task || !(task instanceof AcpAgentManager)) {
        return {
          success: false,
          msg: 'Conversation not found or not an ACP agent',
        };
      }
      return {
        success: true,
        data: { modelInfo: await task.setModel(modelId) },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, msg: errorMsg };
    }
  });

  ipcBridge.acpConversation.setMode.provider(async ({ conversationId, mode }) => {
    try {
      const task = await workerTaskManager.getOrBuildTask(conversationId);
      if (!task) {
        return { success: false, msg: 'Conversation not found' };
      }
      if (!(task instanceof AcpAgentManager || task instanceof GeminiAgentManager || task instanceof WCoreManager)) {
        return {
          success: false,
          msg: 'Mode switching not supported for this agent type',
        };
      }
      return await task.setMode(mode);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, msg: errorMsg };
    }
  });

  ipcBridge.acpConversation.getConfigOptions.provider(({ conversationId }) => {
    const task = workerTaskManager.getTask(conversationId);
    if (!task || !(task instanceof AcpAgentManager)) {
      return Promise.resolve({ success: true, data: { configOptions: [] } });
    }
    return Promise.resolve({
      success: true,
      data: { configOptions: task.getConfigOptions() },
    });
  });

  ipcBridge.acpConversation.setConfigOption.provider(async ({ conversationId, configId, value }) => {
    try {
      const task = await workerTaskManager.getOrBuildTask(conversationId);
      if (!task || !(task instanceof AcpAgentManager)) {
        return {
          success: false,
          msg: 'Conversation not found or not an ACP agent',
        };
      }
      const configOptions = await task.setConfigOption(configId, value);
      return { success: true, data: { configOptions } };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, msg: errorMsg };
    }
  });
}
