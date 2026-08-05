/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Every project gets one folder, and its chats use it.
 *
 * Allocation has to be idempotent and serialised per project: two chats opened
 * at once must not each decide the project has no folder and each make one,
 * which would split the project across `Name` and `Name 2` - the very failure
 * this exists to prevent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IProject } from '@/common/types/project';

let home: string;

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => home };
});

import {
  allocateProjectWorkspace,
  ensureProjectWorkspace,
  projectWorkspaceRoot,
} from '@process/services/projectWorkspace';

type Store = {
  getProject: (id: string) => Promise<IProject | null>;
  updateProject: (id: string, patch: { workspace: string }) => Promise<unknown>;
};

function makeStore(projects: Record<string, IProject>): { store: Store; updates: Array<[string, string]> } {
  const updates: Array<[string, string]> = [];
  return {
    updates,
    store: {
      getProject: async (id) => projects[id] ?? null,
      updateProject: async (id, patch) => {
        updates.push([id, patch.workspace]);
        projects[id] = { ...projects[id], workspace: patch.workspace };
      },
    },
  };
}

const project = (over: Partial<IProject> = {}): IProject =>
  ({ id: 'p1', name: 'Website', createTime: 1, modifyTime: 1, pinned: false, ...over }) as IProject;

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'darhai-home-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('ensureProjectWorkspace', () => {
  it('gives a project without a folder one in the user’s documents', async () => {
    // Not the app's hidden data directory - somewhere they can open and back up.
    const { store, updates } = makeStore({ p1: project() });

    const workspace = await ensureProjectWorkspace('p1', store);

    expect(workspace).toBe(join(projectWorkspaceRoot(), 'Website'));
    expect(await exists(workspace!)).toBe(true);
    expect(updates).toEqual([['p1', workspace]]);
  });

  it('keeps the folder the user chose', async () => {
    const chosen = join(home, 'my-code');
    const { store, updates } = makeStore({ p1: project({ workspace: chosen }) });

    expect(await ensureProjectWorkspace('p1', store)).toBe(chosen);
    expect(updates).toEqual([]);
  });

  it('answers the same folder every time, so a project never splits', async () => {
    const { store } = makeStore({ p1: project() });

    const first = await ensureProjectWorkspace('p1', store);
    const second = await ensureProjectWorkspace('p1', store);

    expect(second).toBe(first);
  });

  it('two chats opened at once land in the same folder', async () => {
    // The race the in-flight map exists for: without it both see "no folder",
    // both allocate, and the project ends up in Website and Website 2.
    const { store, updates } = makeStore({ p1: project() });

    const [a, b] = await Promise.all([ensureProjectWorkspace('p1', store), ensureProjectWorkspace('p1', store)]);

    expect(a).toBe(b);
    expect(updates).toHaveLength(1);
  });

  it('gives two projects with the same name separate folders', async () => {
    // Sharing one would merge their files with nothing said.
    const { store } = makeStore({ p1: project(), p2: project({ id: 'p2' }) });

    const first = await ensureProjectWorkspace('p1', store);
    const second = await ensureProjectWorkspace('p2', store);

    expect(second).not.toBe(first);
  });

  it('reports nothing rather than inventing a folder for a project it cannot read', async () => {
    const { store } = makeStore({});

    expect(await ensureProjectWorkspace('missing', store)).toBeUndefined();
  });
});

describe('allocateProjectWorkspace', () => {
  it('creates the folder for a project being made', async () => {
    const workspace = await allocateProjectWorkspace('New Idea');

    expect(workspace).toBe(join(projectWorkspaceRoot(), 'New Idea'));
    expect(await exists(workspace!)).toBe(true);
  });

  it('avoids a folder that is already there', async () => {
    await mkdir(join(projectWorkspaceRoot(), 'New Idea'), { recursive: true });

    expect(await allocateProjectWorkspace('New Idea')).toBe(join(projectWorkspaceRoot(), 'New Idea 2'));
  });

  it('reports nothing rather than blocking project creation', async () => {
    // A project with no folder still works - its chats fall back to the old
    // behaviour - so a filesystem problem must never stop someone making one.
    home = join(home, 'gone');
    const workspace = await allocateProjectWorkspace('New Idea').catch(() => 'threw');

    expect(workspace).not.toBe('threw');
  });
});
