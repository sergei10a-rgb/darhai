/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { suggestRoster } from '@process/team/suggestRoster';
import type { TeamSessionService } from '@process/team/TeamSessionService';
import { ExtensionRegistry } from '@process/extensions/ExtensionRegistry';
import type { SpecialistCatalog } from '@process/team/importExport/importTeam';
import type { RitualsResolver } from '@process/team/importExport/exportTeam';

/**
 * Wrap an async provider handler so that unhandled rejections are caught and
 * logged instead of silently swallowed by the platform bridge (which only
 * chains `.then()` without `.catch()` on the provider callback).
 *
 * Returning `{ __bridgeError: true, message }` unblocks the renderer-side
 * `invoke()` promise so the UI never "freezes".
 */
function safeProvider<R, P>(fn: (params: P) => Promise<R>) {
  return async (params: P): Promise<R> => {
    try {
      return await fn(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[teamBridge] provider error:', message);
      // Return a sentinel the renderer can detect
      return { __bridgeError: true, message } as unknown as R;
    }
  };
}

let _teamSessionService: TeamSessionService | null = null;

export function initTeamBridge(teamSessionService: TeamSessionService): void {
  _teamSessionService = teamSessionService;
  ipcBridge.team.create.provider(
    safeProvider(async (params) => {
      return teamSessionService.createTeam(params);
    })
  );

  ipcBridge.team.list.provider(
    safeProvider(async ({ userId }) => {
      return teamSessionService.listTeams(userId);
    })
  );

  ipcBridge.team.get.provider(
    safeProvider(async ({ id }) => {
      return teamSessionService.getTeam(id);
    })
  );

  ipcBridge.team.remove.provider(
    safeProvider(async ({ id }) => {
      await teamSessionService.deleteTeam(id);
    })
  );

  ipcBridge.team.addAgent.provider(
    safeProvider(async ({ teamId, agent }) => {
      return teamSessionService.addAgent(teamId, agent);
    })
  );

  ipcBridge.team.removeAgent.provider(
    safeProvider(async ({ teamId, slotId }) => {
      await teamSessionService.removeAgent(teamId, slotId);
    })
  );

  ipcBridge.team.restartAgent.provider(
    safeProvider(async ({ teamId, slotId }) => {
      await teamSessionService.restartAgent(teamId, slotId);
    })
  );

  ipcBridge.team.renameAgent.provider(
    safeProvider(async ({ teamId, slotId, newName }) => {
      await teamSessionService.renameAgent(teamId, slotId, newName);
    })
  );

  ipcBridge.team.renameTeam.provider(
    safeProvider(async ({ id, name }) => {
      await teamSessionService.renameTeam(id, name);
    })
  );

  ipcBridge.team.setSessionMode.provider(
    safeProvider(async ({ teamId, sessionMode }) => {
      await teamSessionService.setSessionMode(teamId, sessionMode);
    })
  );

  ipcBridge.team.updateWorkspace.provider(
    safeProvider(async ({ teamId, workspace }) => {
      await teamSessionService.updateWorkspace(teamId, workspace);
    })
  );

  // W3b — promote/demote handlers. Service methods are idempotent; the
  // provider just translates IPC → service and surfaces errors via safeProvider.
  ipcBridge.team.promoteToStanding.provider(
    safeProvider(async ({ teamId }) => {
      await teamSessionService.promoteTeamToStanding(teamId);
    })
  );

  ipcBridge.team.demoteFromStanding.provider(
    safeProvider(async ({ teamId }) => {
      await teamSessionService.demoteTeamFromStanding(teamId);
    })
  );

  ipcBridge.team.sendMessage.provider(
    safeProvider(async ({ teamId, content, files }) => {
      const session = await teamSessionService.getOrStartSession(teamId);
      await session.sendMessage(content, files);
    })
  );

  ipcBridge.team.sendMessageToAgent.provider(
    safeProvider(async ({ teamId, slotId, content, files }) => {
      const session = await teamSessionService.getOrStartSession(teamId);
      await session.sendMessageToAgent(slotId, content, { files });
    })
  );

  ipcBridge.team.stop.provider(
    safeProvider(async ({ teamId }) => {
      await teamSessionService.stopSession(teamId);
    })
  );

  ipcBridge.team.ensureSession.provider(
    safeProvider(async ({ teamId }) => {
      await teamSessionService.getOrStartSession(teamId);
    })
  );

  // W1e — list team_event_log rows for the Activity tab + cost meter.
  ipcBridge.team.listEvents.provider(
    safeProvider(async ({ teamId, since, limit, eventType }) => {
      return teamSessionService.listEvents(teamId, { since, limit, eventType });
    })
  );

  // W3c — pure server-side roster suggester. No I/O; runs the keyword
  // scorer + recommendBackend over the renderer-provided specialist pool.
  ipcBridge.team.suggestRoster.provider(
    safeProvider(async (params) => {
      return suggestRoster(params);
    })
  );

  // W4 (T4.1) — team export. Resolves rituals from the live extension
  // registry; if the registry has not booted yet the export still works
  // but omits rituals.
  ipcBridge.team.export.provider(
    safeProvider(async ({ teamId }) => {
      return teamSessionService.exportTeam(teamId, makeRitualsResolver());
    })
  );

  // W4 (T4.2 + T4.6 + T4.6.1) — preview an import payload. All guard
  // failures are translated to JSON error sentinels by safeProvider so the
  // renderer can surface them in the import dialog.
  ipcBridge.team.importPreview.provider(
    safeProvider(async ({ jsonText }) => {
      return teamSessionService.previewTeamImport(jsonText, makeSpecialistCatalog());
    })
  );

  // W4 (T4.5 + T4.6) — accept an already-previewed import + persist.
  // W4b will add a renderer-side capability-review dialog ahead of this
  // call; until then, the renderer MUST pass an empty grants map.
  ipcBridge.team.importAccept.provider(
    safeProvider(async ({ userId, parsed, capabilityGrants, source }) => {
      return teamSessionService.acceptTeamImport({
        userId,
        parsed,
        capabilityGrants,
        source,
        specialistCatalog: makeSpecialistCatalog(),
      });
    })
  );
}

/**
 * Build the specialist-id catalog from the live ExtensionRegistry. The
 * registry stores assistants with ids prefixed `ext-<id>`; the export
 * format uses the unprefixed id so the catalog set must mirror that.
 */
function makeSpecialistCatalog(): SpecialistCatalog {
  return async () => {
    const registry = ExtensionRegistry.getInstance();
    const assistants = registry.getAssistants();
    const ids = new Set<string>();
    for (const a of assistants) {
      const rawId = (a as { id?: string }).id;
      if (typeof rawId !== 'string') continue;
      const stripped = rawId.startsWith('ext-') ? rawId.slice(4) : rawId;
      ids.add(stripped);
    }
    return ids;
  };
}

/**
 * Look up the `rituals` array for a source launcher id by walking the
 * extension registry's assistant list. Returns undefined when no match.
 */
function makeRitualsResolver(): RitualsResolver {
  return async (sourceLauncherId: string) => {
    const registry = ExtensionRegistry.getInstance();
    const assistants = registry.getAssistants();
    const norm = sourceLauncherId.startsWith('ext-') ? sourceLauncherId : `ext-${sourceLauncherId}`;
    for (const a of assistants) {
      const candidate = a as { id?: string; rituals?: Array<{ name: string; cadence: string }> };
      if (candidate.id === norm || candidate.id === sourceLauncherId) {
        return candidate.rituals;
      }
    }
    return undefined;
  };
}

/** Stop all active team sessions (TCP servers + child processes). Call on app quit. */
export function disposeAllTeamSessions(): Promise<void> {
  return _teamSessionService?.stopAllSessions() ?? Promise.resolve();
}
