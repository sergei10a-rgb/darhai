/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where a persisted assistant actually lives.
 *
 * A one-time migration (`migration.assistantsSplitCustom`) split what used to be
 * one list in two: `assistants` keeps the presets we ship, `acp.customAgents`
 * keeps the ones the user made. A third kind - the specialists an extension
 * contributes - is never persisted at all; it exists only in the in-memory
 * registry the list merges in.
 *
 * The editor wrote to `assistants` alone. Mapping over a list that does not
 * contain the id is not an error in JavaScript: it returns the same list, the
 * write succeeds, and "Saved successfully" appears over an edit that went
 * nowhere. Anyone whose custom agents predate the migration lost every change
 * they made to them, silently.
 *
 * These helpers answer "which store holds this id" once, so a write either
 * lands in the right list or reports that it could not.
 */

import type { AcpBackendConfig } from '@/common/types/acpTypes';
import { ConfigStorage } from '@/common/config/storage';

/** The two config keys that persist assistants, in lookup order. */
const STORE_KEYS = ['assistants', 'acp.customAgents'] as const;

export type AssistantStoreKey = (typeof STORE_KEYS)[number];

async function readStore(key: AssistantStoreKey): Promise<AcpBackendConfig[]> {
  const value = await ConfigStorage.get(key);
  return Array.isArray(value) ? value : [];
}

/**
 * The store holding `id`, or null when nothing persisted holds it.
 *
 * Null is the normal answer for an extension-contributed specialist, so callers
 * should treat it as "not mine to write", not as a failure of the lookup.
 */
export async function findAssistantStore(id: string): Promise<AssistantStoreKey | null> {
  for (const key of STORE_KEYS) {
    const list = await readStore(key);
    if (list.some((agent) => agent.id === id)) return key;
  }
  return null;
}

/**
 * Replace the stored record for `id` with `update(previous)`.
 *
 * Returns false without writing anything when no store holds the id - the
 * caller is expected to say so rather than report a save that did not happen.
 */
export async function updateStoredAssistant(
  id: string,
  update: (previous: AcpBackendConfig) => AcpBackendConfig
): Promise<boolean> {
  for (const key of STORE_KEYS) {
    const list = await readStore(key);
    const index = list.findIndex((agent) => agent.id === id);
    if (index < 0) continue;
    const next = [...list];
    next[index] = update(list[index]);
    await ConfigStorage.set(key, next);
    return true;
  }
  return false;
}

/**
 * Drop the stored record for `id`. Returns false when no store held it, so a
 * delete that removed nothing cannot report success.
 */
export async function removeStoredAssistant(id: string): Promise<boolean> {
  for (const key of STORE_KEYS) {
    const list = await readStore(key);
    if (!list.some((agent) => agent.id === id)) continue;
    await ConfigStorage.set(
      key,
      list.filter((agent) => agent.id !== id)
    );
    return true;
  }
  return false;
}
