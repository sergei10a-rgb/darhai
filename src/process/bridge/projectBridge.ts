/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { projectServiceSingleton as projectService } from '@process/services/projectServiceSingleton';

/**
 * Initialize project IPC bridge handlers. A project is an umbrella over
 * conversations; there is no execution lock, so none of these handlers gate on
 * a "currently running" conversation. `changed` is emitted after every mutation
 * so the renderer can refresh the project list and per-project chat counts.
 */
export function initProjectBridge(): void {
  ipcBridge.project.create.provider(async (params) => {
    const project = await projectService.createProject(params);
    ipcBridge.project.changed.emit();
    return project;
  });

  ipcBridge.project.get.provider(async ({ id }) => {
    return projectService.getProject(id);
  });

  ipcBridge.project.list.provider(async () => {
    return projectService.listProjects();
  });

  ipcBridge.project.update.provider(async ({ id, updates }) => {
    await projectService.updateProject(id, updates);
    ipcBridge.project.changed.emit();
  });

  ipcBridge.project.remove.provider(async ({ id }) => {
    await projectService.removeProject(id);
    ipcBridge.project.changed.emit();
  });

  ipcBridge.project.getConversations.provider(async ({ projectId }) => {
    return projectService.getProjectConversations(projectId);
  });

  ipcBridge.project.assignConversation.provider(async ({ conversationId, projectId }) => {
    await projectService.assignConversation(conversationId, projectId);
    ipcBridge.project.changed.emit();
  });

  ipcBridge.project.removeConversation.provider(async ({ conversationId }) => {
    await projectService.removeConversationFromProject(conversationId);
    ipcBridge.project.changed.emit();
  });
}
