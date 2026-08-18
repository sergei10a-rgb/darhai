/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The per-workspace write identity: a deterministic `S-1-4-x-y` SID derived
 * from the canonical workspace path, whose ACEs form that workspace's write
 * allowlist. Ported from the deepseek-harness windows-acl `workspace-sid.ts`.
 * Every confined execution of the same workspace carries the SAME write SID, so
 * the workspace-root ACE materializes once per workspace per machine. The SID's
 * power is defined solely by the ACEs that name it (which exist only on the
 * workspace tree), so the SID string itself is not a secret.
 *
 * @module @process/services/sandbox/workspaceSid
 */

import { createHash } from 'node:crypto';

/**
 * Derive the workspace's write SID (`S-1-4-x-y`; subauthorities 30-bit). The
 * input MUST be the canonical (realpath) workspace path so two spellings of one
 * workspace derive one SID.
 *
 * @param workspaceRoot - the canonical workspace path.
 * @returns the SDDL string form.
 */
export function workspaceWriteSid(workspaceRoot: string): string {
  const digest = createHash('sha256').update(workspaceRoot, 'utf8').digest();
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
  return `S-1-4-${first}-${second}`;
}
