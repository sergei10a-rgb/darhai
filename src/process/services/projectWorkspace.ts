/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Give every project a folder of its own, and make its chats use it.
 *
 * See `workspaceLocation.ts` for why the old behaviour - a fresh
 * `wcore-temp-<timestamp>` per chat, inside the app's data folder - lost both
 * the files and the continuity between a project's chats.
 *
 * Allocation is idempotent and serialised per project: two chats created at
 * once must not race into two different folders, which would reproduce the very
 * split this exists to prevent.
 */

import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IProject } from '@/common/types/project';
import { resolveProjectWorkspacePath } from '@process/utils/workspaceLocation';

/** The folder that holds every auto-allocated project workspace. */
export function projectWorkspaceRoot(): string {
  return join(homedir(), 'Documents', 'Darhai');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * In-flight allocations, so concurrent callers for one project share a result.
 *
 * Without this, two chats opened together would each see "no workspace", each
 * allocate, and land in `Name` and `Name 2` - a project split across two
 * folders, which is the failure this whole module is about.
 */
const inFlight = new Map<string, Promise<string>>();

/** The store this needs, narrowed so tests need not build a whole service. */
export type ProjectWorkspaceStore = {
  getProject(id: string): Promise<IProject | null>;
  updateProject(id: string, patch: { workspace: string }): Promise<unknown>;
};

/**
 * The project's workspace, allocating and persisting one if it has none.
 *
 * Returns undefined only when the project itself cannot be read - the caller
 * then behaves as before rather than inventing a folder for a project that may
 * not exist.
 */
export async function ensureProjectWorkspace(
  projectId: string,
  store: ProjectWorkspaceStore
): Promise<string | undefined> {
  const pending = inFlight.get(projectId);
  if (pending) return pending;

  const task = (async () => {
    const project = await store.getProject(projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    if (project.workspace) return project.workspace;

    const root = projectWorkspaceRoot();
    await mkdir(root, { recursive: true });
    const workspace = await resolveProjectWorkspacePath(root, project.name, pathExists);
    await mkdir(workspace, { recursive: true });
    await store.updateProject(projectId, { workspace });
    return workspace;
  })();

  inFlight.set(projectId, task);
  try {
    return await task;
  } catch (error) {
    console.warn('[projectWorkspace] Could not resolve a workspace for the project:', error);
    return undefined;
  } finally {
    inFlight.delete(projectId);
  }
}

/** Allocate a folder for a project being created, without touching the store. */
export async function allocateProjectWorkspace(projectName: string): Promise<string | undefined> {
  try {
    const root = projectWorkspaceRoot();
    await mkdir(root, { recursive: true });
    const workspace = await resolveProjectWorkspacePath(root, projectName, pathExists);
    await mkdir(workspace, { recursive: true });
    return workspace;
  } catch (error) {
    // A project without a folder still works - its chats fall back to the old
    // behaviour - so this must never block creating one.
    console.warn('[projectWorkspace] Could not allocate a workspace folder:', error);
    return undefined;
  }
}
