// src/process/acp/session/ApprovalPersistence.ts

import { ProcessConfig } from '@process/utils/initStorage';
import { mainError, mainLog } from '@process/utils/mainLogger';

/**
 * Durable "allow always" approvals, keyed by workspace (cwd).
 *
 * The live approval cache in {@link PermissionResolver} is an in-memory,
 * session-scoped LRU, so every "always allow" was re-prompted after each app
 * restart. This module persists only the durable decisions to config so a
 * restarted session can rehydrate them.
 *
 * Scope: allow-always decisions ONLY. deny and allow-once are never persisted
 * (the resolver enforces that on the write side too). Every path is fail-soft:
 * a config read/write error logs and returns/skips rather than throwing into
 * the permission flow.
 */

const CONFIG_KEY = 'acp.workspaceApprovals';

/** cacheKey -> optionId, grouped by workspace cwd. */
type WorkspaceApprovals = Record<string, Array<[string, string]>>;

async function readAll(): Promise<WorkspaceApprovals> {
  try {
    const raw = await ProcessConfig.get(CONFIG_KEY);
    if (raw && typeof raw === 'object') {
      return raw as WorkspaceApprovals;
    }
  } catch (error) {
    mainError('[ApprovalPersistence] failed to read approvals', error);
  }
  return {};
}

/**
 * Load the persisted allow-always entries for a workspace as
 * [cacheKey, optionId] pairs. Never throws; returns [] on any failure.
 */
export async function loadWorkspaceApprovals(cwd: string): Promise<Array<[string, string]>> {
  if (!cwd) return [];
  const all = await readAll();
  const entries = all[cwd];
  return Array.isArray(entries) ? entries : [];
}

/**
 * Persist a single allow-always decision for a workspace. Skips the write when
 * the same (key, optionId) is already stored (avoids churning config on every
 * repeated approval). Never throws.
 */
export async function saveWorkspaceApproval(cwd: string, cacheKey: string, optionId: string): Promise<void> {
  if (!cwd) return;
  try {
    const all = await readAll();
    const list = all[cwd] ?? [];
    const existing = list.find(([k]) => k === cacheKey);
    if (existing && existing[1] === optionId) {
      return; // redundant write - nothing changed
    }
    const next = list.filter(([k]) => k !== cacheKey);
    next.push([cacheKey, optionId]);
    all[cwd] = next;
    await ProcessConfig.set(CONFIG_KEY, all);
  } catch (error) {
    mainError('[ApprovalPersistence] failed to save approval', error);
  }
}

/**
 * Drop all persisted approvals for a workspace (e.g. a "forget approvals"
 * action). Never throws.
 */
export async function clearWorkspaceApprovals(cwd: string): Promise<void> {
  if (!cwd) return;
  try {
    const all = await readAll();
    if (all[cwd]) {
      delete all[cwd];
      await ProcessConfig.set(CONFIG_KEY, all);
      mainLog('[ApprovalPersistence] cleared approvals for', cwd);
    }
  } catch (error) {
    mainError('[ApprovalPersistence] failed to clear approvals', error);
  }
}
