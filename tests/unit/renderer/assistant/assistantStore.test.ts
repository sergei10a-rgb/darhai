/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Editing a custom assistant used to be a no-op that said it worked.
 *
 * The `migration.assistantsSplitCustom` migration moved every user-made agent
 * out of the `assistants` config key into `acp.customAgents`. The editor kept
 * writing through `assistants.map(...)`, which quietly returns the same list
 * when the id is not in it - so the write succeeded, the list reloaded
 * unchanged, and "Saved successfully" appeared over an edit that was gone. Same
 * for the enable toggle, and delete removed nothing.
 *
 * What is pinned here is that a write goes to whichever store holds the id, and
 * that a write with no home reports false instead of pretending.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpBackendConfig } from '@/common/types/acpTypes';

const store: Record<string, unknown> = {};

vi.mock('@/common/config/storage', () => ({
  ConfigStorage: {
    get: async (key: string) => store[key],
    set: async (key: string, value: unknown) => {
      store[key] = value;
    },
  },
}));

import {
  findAssistantStore,
  removeStoredAssistant,
  updateStoredAssistant,
} from '@renderer/hooks/assistant/assistantStore';

const agent = (id: string, name = id): AcpBackendConfig => ({ id, name }) as unknown as AcpBackendConfig;

const readList = (key: string): AcpBackendConfig[] => (store[key] as AcpBackendConfig[]) ?? [];

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  store['assistants'] = [agent('preset-writer')];
  store['acp.customAgents'] = [agent('custom-mine')];
});

describe('findAssistantStore', () => {
  it('finds a preset and a custom agent in their own stores', async () => {
    expect(await findAssistantStore('preset-writer')).toBe('assistants');
    expect(await findAssistantStore('custom-mine')).toBe('acp.customAgents');
  });

  it('reports null for an extension specialist, which is persisted nowhere', async () => {
    expect(await findAssistantStore('ext-translator')).toBeNull();
  });

  it('survives a store that is missing or holds something that is not a list', async () => {
    delete store['acp.customAgents'];
    expect(await findAssistantStore('custom-mine')).toBeNull();
    store['assistants'] = 'not a list';
    expect(await findAssistantStore('preset-writer')).toBeNull();
  });
});

describe('updateStoredAssistant', () => {
  it('writes a custom agent back to the store that holds it', async () => {
    // The defect, stated directly: this edit used to land nowhere.
    const ok = await updateStoredAssistant('custom-mine', (prev) => ({ ...prev, name: 'renamed' }));

    expect(ok).toBe(true);
    expect(readList('acp.customAgents')[0].name).toBe('renamed');
    expect(readList('assistants')).toEqual([agent('preset-writer')]);
  });

  it('writes a preset back to the preset store', async () => {
    expect(await updateStoredAssistant('preset-writer', (prev) => ({ ...prev, name: 'renamed' }))).toBe(true);
    expect(readList('assistants')[0].name).toBe('renamed');
  });

  it('reports false and writes nothing when no store holds the id', async () => {
    const before = JSON.stringify(store);

    expect(await updateStoredAssistant('ext-translator', (prev) => ({ ...prev, name: 'x' }))).toBe(false);
    expect(JSON.stringify(store)).toBe(before);
  });

  it('keeps the other entries in the list it writes', async () => {
    store['acp.customAgents'] = [agent('a'), agent('custom-mine'), agent('z')];

    await updateStoredAssistant('custom-mine', (prev) => ({ ...prev, name: 'renamed' }));

    expect(readList('acp.customAgents').map((a) => a.id)).toEqual(['a', 'custom-mine', 'z']);
    expect(readList('acp.customAgents').map((a) => a.name)).toEqual(['a', 'renamed', 'z']);
  });

  it('does not mutate the array it read', async () => {
    const original = readList('acp.customAgents');
    await updateStoredAssistant('custom-mine', (prev) => ({ ...prev, name: 'renamed' }));
    expect(original[0].name).toBe('custom-mine');
  });
});

describe('removeStoredAssistant', () => {
  it('removes a custom agent from the store that holds it', async () => {
    expect(await removeStoredAssistant('custom-mine')).toBe(true);
    expect(readList('acp.customAgents')).toEqual([]);
    expect(readList('assistants')).toHaveLength(1);
  });

  it('reports false when nothing held the id, so delete cannot claim success', async () => {
    const before = JSON.stringify(store);

    expect(await removeStoredAssistant('ext-translator')).toBe(false);
    expect(JSON.stringify(store)).toBe(before);
  });
});
