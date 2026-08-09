/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConfigStorage } from '@/common/config/storage';
import type { AcpBackendAll } from '@/common/types/acpTypes';
import type { AcpBackend } from '../types';

/** Save preferred mode to the agent's own config key */
export async function savePreferredMode(agentKey: string, mode: string): Promise<void> {
  try {
    if (agentKey === 'gemini') {
      const config = await ConfigStorage.get('gemini.config');
      await ConfigStorage.set('gemini.config', { ...config, preferredMode: mode });
    } else if (agentKey === 'wcore') {
      const config = await ConfigStorage.get('wcore.config');
      await ConfigStorage.set('wcore.config', { ...config, preferredMode: mode });
    } else if (agentKey !== 'custom') {
      const config = await ConfigStorage.get('acp.config');
      const backendConfig = config?.[agentKey as AcpBackendAll] || {};
      await ConfigStorage.set('acp.config', { ...config, [agentKey]: { ...backendConfig, preferredMode: mode } });
    }
  } catch {
    /* silent */
  }
}

/** Save preferred model ID to the agent's acp.config key */
export async function savePreferredModelId(agentKey: string, modelId: string): Promise<void> {
  try {
    const config = await ConfigStorage.get('acp.config');
    const backendConfig = config?.[agentKey as AcpBackendAll] || {};
    await ConfigStorage.set('acp.config', { ...config, [agentKey]: { ...backendConfig, preferredModelId: modelId } });
  } catch {
    /* silent */
  }
}

/**
 * Get agent key for selection.
 * Returns "custom:uuid" for custom agents, "remote:uuid" for remote agents, backend type for others.
 */
export const getAgentKey = (agent: { backend: AcpBackend; customAgentId?: string; isPreset?: boolean }): string => {
  if (agent.backend === 'remote' && agent.customAgentId) return `remote:${agent.customAgentId}`;
  if (agent.customAgentId) return `custom:${agent.customAgentId}`;
  return agent.backend;
};

/**
 * Filter the detected agents down to the ones shown in the Guid-page toolbar
 * strip, removing any the user hid on the Agents settings page.
 *
 * Two guard rails keep the strip usable:
 *  1. The currently-selected agent is never hidden out from under the user,
 *     even if its key is in `hiddenSet`.
 *  2. The strip is never collapsed to empty: if every agent would be hidden,
 *     the full set is returned unchanged.
 *
 * `undefined` (agents still loading) is passed through so the caller can keep
 * showing its skeleton.
 */
export function filterVisibleAgents<T extends { backend: AcpBackend; customAgentId?: string }>(
  agents: T[] | undefined,
  hiddenSet: ReadonlySet<string>,
  selectedAgentKey: string
): T[] | undefined {
  if (!agents) return agents;
  const visible = agents.filter((agent) => {
    const key = getAgentKey(agent);
    return !hiddenSet.has(key) || key === selectedAgentKey;
  });
  return visible.length > 0 ? visible : agents;
}

/**
 * The agent key one step from `currentKey` in the visible strip.
 *
 * Backs the home screen's Tab / Shift+Tab shortcut, which the hint bar
 * advertised long before any handler existed - the pills were plain
 * `<div onClick>` with no `tabIndex`, so Tab could not even focus them and the
 * press fell through to the browser's own focus move.
 *
 * Wraps around in both directions. Returns `null` when there is nothing to
 * cycle to (no agents, a single agent, or an unknown current key), so the
 * caller can leave the event alone and let Tab keep its default meaning.
 */
export function cycleAgentKey<T extends { backend: AcpBackend; customAgentId?: string }>(
  agents: T[] | undefined,
  currentKey: string,
  direction: 1 | -1
): string | null {
  if (!agents || agents.length < 2) return null;
  const keys = agents.map((agent) => getAgentKey(agent));
  const index = keys.indexOf(currentKey);
  if (index === -1) return null;
  const next = (index + direction + keys.length) % keys.length;
  return keys[next] ?? null;
}
