/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public types for the OS-level process sandbox. On Windows the confined modes
 * are enforced by a `CreateRestrictedToken` write-restricted token (ported from
 * the deepseek-harness windows-acl backend); other platforms report the
 * confinement as unavailable and fail closed.
 *
 * @module @process/services/sandbox/types
 */

/**
 * File-effect policy for a confined process. `read-only` denies writes outside
 * the ambient sinks the child needs to start; `workspace-write` additionally
 * permits writes under the workspace root; `danger-full-access` bypasses
 * confinement entirely (the caller spawns its original argv, unrestricted).
 * Mirrors the `sandboxMode` vocabulary already carried in Darhai's Codex config.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** A confining (non-`danger-full-access`) mode — the modes the token layer can enforce. */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>;

/**
 * Enforcement completeness this host achieves for a confined policy.
 *
 * - `full`: the backend governs every file effect the mode promises.
 * - `partial`: the backend governs only a subset. The Windows ACL backend is
 *   ALWAYS partial — `WRITE_RESTRICTED` must keep `Everyone` in the restricting
 *   list for process startup, and NTFS hard links can alias a granted file to a
 *   path outside the allowed tree. Callers that require an absolute boundary
 *   must not treat `partial` as `full`.
 * - `none`: no confinement was applied (`danger-full-access`, the caller opted
 *   out). Reported honestly so a bypass is never mistaken for enforcement.
 */
export type SandboxEnforcement = 'full' | 'partial' | 'none';

/**
 * The complete file-effect policy for one confined execution.
 */
export type SandboxPolicy = {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode;
  /**
   * Absolute workspace root the process runs in. Under `workspace-write` this
   * is the only tree the confined child may write to (plus its private temp).
   * Must be an already-resolved absolute path.
   */
  workspaceRoot: string;
};

/** Result of a confined execution — the child's output plus the honest enforcement fact. */
export type SandboxRunResult = {
  stdout: string;
  stderr: string;
  /** The child's process exit code (null when it exited via signal, never observed here). */
  code: number | null;
  /** How completely the sandbox governed this execution's file effects. */
  enforcement: SandboxEnforcement;
};

/** Thrown when a confined policy cannot be enforced on this host — fail closed, the command never runs. */
export class SandboxUnavailableError extends Error {
  readonly code = 'SANDBOX_UNAVAILABLE';
  constructor(
    readonly mode: SandboxMode,
    detail: string
  ) {
    super(`Sandbox unavailable for mode "${mode}": ${detail}. The command was NOT run (fail-closed).`);
    this.name = 'SandboxUnavailableError';
  }
}
