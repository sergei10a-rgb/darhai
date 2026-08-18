/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OS-level process sandbox for host-side command execution. Orchestrates the
 * Windows `CreateRestrictedToken` write-restricted backend (ported from
 * deepseek-harness windows-acl) into a single `runSandboxed` entry point.
 *
 * Design invariants:
 *  - FAIL-CLOSED. A confined policy that cannot be enforced (non-Windows host,
 *    koffi/bindings failure, token construction failure, ACL-grant failure)
 *    throws {@link SandboxUnavailableError} and the command is NEVER run. Silent
 *    unconfined passthrough is forbidden.
 *  - HONEST ENFORCEMENT. Confined runs on Windows report `partial` — the ACL
 *    backend cannot govern every file effect (Everyone stays in the restricting
 *    list for process startup; NTFS hard links can alias a granted file). A
 *    caller requiring an absolute boundary must not treat `partial` as `full`.
 *  - `danger-full-access` applies NO confinement; callers that resolve to it
 *    must run their original argv unconfined and report enforcement `none`.
 *
 * @module @process/services/sandbox
 */

import { grantWrite } from './aclGrant'; // re-exported for consumers; see below
import { WorkspaceWriteGrant } from './aclGrant';
import {
  createRestrictedToken,
  findLogonSid,
  makeWellKnownSid,
  openCurrentProcessToken,
  setTokenDefaultDaclGrant,
} from './restrictedToken';
import { drainPipe, spawnSandboxed, waitForExit } from './sandboxedSpawn';
import type { ConfinedSandboxMode, SandboxEnforcement, SandboxMode, SandboxPolicy, SandboxRunResult } from './types';
import { SandboxUnavailableError } from './types';
import type { NativePtr, Win32Bindings } from './win32Bindings';
import { win32 } from './win32Bindings';
import { WinWorldSid } from './win32Constants';
import { workspaceWriteSid } from './workspaceSid';

export type { SandboxMode, ConfinedSandboxMode, SandboxEnforcement, SandboxPolicy, SandboxRunResult } from './types';
export { SandboxUnavailableError } from './types';
export { workspaceWriteSid } from './workspaceSid';
export { restrictingSidPlan } from './restrictedToken';
export { quoteArg, buildCommandLine } from './sandboxedSpawn';
// Surface the low-level grant primitive so an out-of-band caller can pre-warm a
// workspace ACE without spawning (unused internally beyond WorkspaceWriteGrant).
export { grantWrite };

/**
 * The set of modes whose confinement this host can actually enforce. Only
 * Windows carries the ACL restricted-token backend; every other platform
 * returns an empty set, so a confined policy fails closed there.
 *
 * @returns the enforceable confined modes on this host.
 */
export function supportedConfinedModes(): readonly ConfinedSandboxMode[] {
  return process.platform === 'win32' ? ['read-only', 'workspace-write'] : [];
}

/** True when a confined policy can be enforced at the OS level on this host. */
export function isSandboxSupported(): boolean {
  return supportedConfinedModes().length > 0;
}

/**
 * The enforcement completeness a mode achieves on THIS host, reported honestly.
 * `danger-full-access` is never confined (`none`); the confined modes are
 * `partial` on Windows (the ACL backend's documented Everyone/hard-link gaps)
 * and would throw before running elsewhere.
 *
 * @param mode - the policy mode.
 * @returns the enforcement level a run under this mode would report.
 */
export function enforcementFor(mode: SandboxMode): SandboxEnforcement {
  if (mode === 'danger-full-access') return 'none';
  // Every OS-level backend Darhai carries is the partial Windows ACL runner.
  return 'partial';
}

/**
 * Run `file args` confined under `policy` on this host, returning the child's
 * output and the honest enforcement fact.
 *
 * `danger-full-access` is rejected here — it is not a confined execution, so
 * the caller must spawn its original argv itself rather than route through the
 * sandbox. A non-Windows host or any construction failure throws
 * {@link SandboxUnavailableError}; the command is never run.
 *
 * @param policy - the confined file-effect policy (mode + workspace root).
 * @param file - the executable to run (no shell).
 * @param args - the argument vector, each element passed verbatim.
 * @returns the confined run's stdout/stderr/exit-code plus enforcement level.
 */
export async function runSandboxed(
  policy: SandboxPolicy,
  file: string,
  args: readonly string[]
): Promise<SandboxRunResult> {
  if (policy.mode === 'danger-full-access') {
    throw new SandboxUnavailableError(
      policy.mode,
      'danger-full-access is not a confined mode — the caller must spawn its original argv unconfined'
    );
  }
  const mode: ConfinedSandboxMode = policy.mode;
  if (process.platform !== 'win32') {
    throw new SandboxUnavailableError(
      mode,
      `no OS-level sandbox backend on platform "${process.platform}" (only Windows ACL is implemented)`
    );
  }

  let api: Win32Bindings;
  try {
    api = win32();
  } catch (error) {
    // koffi load / binding failure — fail closed, do not run the command.
    throw new SandboxUnavailableError(
      mode,
      `Win32 bindings unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let restrictedToken: NativePtr | undefined;
  let grant: WorkspaceWriteGrant | undefined;
  try {
    const currentToken = openCurrentProcessToken(api);
    const logonSid = findLogonSid(api, currentToken);
    const world = makeWellKnownSid(api, WinWorldSid);

    let writeSids: readonly NativePtr[] = [];
    let defaultDaclSid: NativePtr = world;
    if (mode === 'workspace-write') {
      const writeSid = workspaceWriteSid(policy.workspaceRoot);
      grant = WorkspaceWriteGrant.create(writeSid, policy.workspaceRoot, api);
      writeSids = [grant.sid];
      defaultDaclSid = grant.sid;
    }

    restrictedToken = createRestrictedToken(api, currentToken, logonSid, world, writeSids, mode);
    // New objects the child creates (its stdio pipes) must carry a restricting
    // SID in their DACL or they fail the WRITE_RESTRICTED pass-2 check.
    setTokenDefaultDaclGrant(api, restrictedToken, defaultDaclSid);

    const spawned = spawnSandboxed(api, restrictedToken, { command: file, args, cwd: policy.workspaceRoot });
    const [stdoutBuf, stderrBuf] = await Promise.all([
      drainPipe(api, spawned.stdoutRead),
      drainPipe(api, spawned.stderrRead),
    ]);
    const code = waitForExit(api, spawned.process);

    return {
      stdout: stdoutBuf.toString('utf8'),
      stderr: stderrBuf.toString('utf8'),
      code,
      enforcement: enforcementFor(mode),
    };
  } finally {
    if (restrictedToken !== undefined) {
      try {
        api.closeHandle(restrictedToken);
      } catch {
        /* best-effort */
      }
    }
    if (grant !== undefined) {
      try {
        grant.dispose();
      } catch {
        /* dispose reports its own cleanup failures; never mask the run outcome */
      }
    }
  }
}
