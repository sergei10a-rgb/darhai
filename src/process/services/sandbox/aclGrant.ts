/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACL editing for the workspace-write grant, ported from the deepseek-harness
 * windows-acl `acl.ts` + `grant.ts`. Grant/revoke a capability SID on a
 * directory via SetEntriesInAclW + SetNamedSecurityInfoW. Every API call is
 * checked and every failure is reported with the API name, the exact Win32
 * code, and the affected path.
 *
 * Concurrency: grants are read-merge-write against the directory's CURRENT
 * DACL, serialized under a per-path exclusive LockFileEx lock so concurrent
 * grants cannot clobber each other's ACEs.
 *
 * @module @process/services/sandbox/aclGrant
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  allocOverlapped,
  allocPtrSlot,
  decodePtr,
  decodeUint16At,
  decodeUint32At,
  decodeUint8At,
  getTempPath,
  isInvalidHandle,
  isNullPtr,
  ptrAddress,
  sameSidAt,
  throwLastError,
  throwWin32,
  win32,
} from './win32Bindings';
import type { NativePtr, Win32Bindings } from './win32Bindings';
import * as abi from './win32Constants';

/**
 * Pack one EXPLICIT_ACCESS_W (48 bytes): perms@0, mode@4, inheritance@8,
 * Trustee@16 { MultipleTrusteeOperation@24, TrusteeForm@28, TrusteeType@32,
 * ptstrName@40 }.
 *
 * @param sidPtr - the trustee SID the entry names.
 * @param mode - GRANT_ACCESS or REVOKE_ACCESS.
 * @param permissions - the access mask to grant (0 for REVOKE_ACCESS).
 * @returns the packed entry buffer.
 */
export function buildExplicitAccess(sidPtr: NativePtr, mode: number, permissions: number): Buffer {
  const entry = Buffer.alloc(abi.EXPLICIT_ACCESS_W_SIZE);
  entry.writeUInt32LE(permissions >>> 0, 0);
  entry.writeUInt32LE(mode, 4);
  entry.writeUInt32LE(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, 8);
  entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, 24);
  entry.writeUInt32LE(abi.TRUSTEE_IS_SID, 28);
  entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, 32);
  entry.writeBigUInt64LE(ptrAddress(sidPtr), 40);
  return entry;
}

/** One lock file per protected path under `<temp>\darhai-acl-locks\<16 hex of sha256(lowercased path)>.lock`. */
function lockFilePath(api: Win32Bindings, path: string): string {
  const digest = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16);
  return join(getTempPath(api), 'darhai-acl-locks', `${digest}.lock`);
}

/** Run `action` holding the per-path exclusive lock. Fail-closed; an action failure still unlocks (best-effort) and rethrows. */
function withPathLock<T>(api: Win32Bindings, path: string, action: () => T): T {
  const lockPath = lockFilePath(api, path);
  mkdirSync(dirname(lockPath), { recursive: true });
  const handle = api.createFileW(
    lockPath,
    abi.GENERIC_READ | abi.GENERIC_WRITE,
    abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE,
    null,
    abi.OPEN_ALWAYS,
    0,
    null
  );
  if (isInvalidHandle(handle)) throwLastError(api, 'CreateFileW', lockPath);
  const overlapped = allocOverlapped();
  if (api.lockFileEx(handle, abi.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(handle);
    throwWin32(api, 'LockFileEx', win32Code, lockPath);
  }
  let result: T;
  try {
    result = action();
  } catch (error) {
    api.unlockFileEx(handle, 0, 1, 0, overlapped);
    api.closeHandle(handle);
    throw error;
  }
  if (api.unlockFileEx(handle, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(handle);
    throwWin32(api, 'UnlockFileEx', win32Code, lockPath);
  }
  if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', `lock file ${lockPath}`);
  return result;
}

/** Read the directory's current explicit DACL. The ACL sits inside the descriptor allocation — only the descriptor may be LocalFree'd. */
function readCurrentDacl(api: Win32Bindings, path: string): { oldAcl: NativePtr | null; descriptor: NativePtr | null } {
  const ownerSlot = allocPtrSlot();
  const groupSlot = allocPtrSlot();
  const daclSlot = allocPtrSlot();
  const saclSlot = allocPtrSlot();
  const descriptorSlot = allocPtrSlot();
  const readResult = api.getNamedSecurityInfoW(
    path,
    abi.SE_FILE_OBJECT,
    abi.DACL_SECURITY_INFORMATION,
    ownerSlot,
    groupSlot,
    daclSlot,
    saclSlot,
    descriptorSlot
  );
  if (readResult !== abi.ERROR_SUCCESS) throwWin32(api, 'GetNamedSecurityInfoW', readResult, path);
  return { oldAcl: decodePtr(daclSlot), descriptor: decodePtr(descriptorSlot) };
}

/** Merge `entry` into `oldAcl`, free the descriptor, apply the merged ACL, then free it — checking every call. */
function mergeAndApply(
  api: Win32Bindings,
  path: string,
  entry: Buffer,
  oldAcl: NativePtr | null,
  descriptor: NativePtr | null,
  label: string
): void {
  const newAclSlot = allocPtrSlot();
  const mergeResult = api.setEntriesInAclW(1, entry, oldAcl, newAclSlot);
  if (mergeResult !== abi.ERROR_SUCCESS) {
    if (descriptor !== null) api.localFree(descriptor);
    throwWin32(api, 'SetEntriesInAclW', mergeResult, `${label}(${path})`);
  }
  const newAcl = decodePtr(newAclSlot);
  if (newAcl === null) {
    if (descriptor !== null) api.localFree(descriptor);
    throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `${label}(${path}): null new ACL`);
  }
  const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null;
  const applyResult = api.setNamedSecurityInfoW(
    path,
    abi.SE_FILE_OBJECT,
    abi.DACL_SECURITY_INFORMATION,
    null,
    null,
    newAcl,
    null
  );
  const freedNew = api.localFree(newAcl);
  if (applyResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetNamedSecurityInfoW', applyResult, `${label}(${path})`);
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor))
    throwLastError(api, 'LocalFree', `${label}(${path}) descriptor`);
  if (!isNullPtr(freedNew)) throwLastError(api, 'LocalFree', `${label}(${path}) new ACL`);
}

/** True when the explicit DACL already carries the EXACT write grant this module would add (idempotent skip). */
function hasExactGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(oldAcl, 2);
  const aceCount = decodeUint16At(oldAcl, 4);
  if (aclSize < 8 || aclSize > 1_048_576) return false;
  let offset = 8;
  for (let index = 0; index < aceCount; index++) {
    const aceSize = decodeUint16At(oldAcl, offset + 2);
    if (aceSize < 8 || offset + aceSize > aclSize) return false;
    const exact =
      decodeUint8At(oldAcl, offset) === abi.ACCESS_ALLOWED_ACE_TYPE &&
      decodeUint8At(oldAcl, offset + 1) === abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT &&
      decodeUint32At(oldAcl, offset + 4) === abi.GRANT_MASK;
    if (exact && sameSidAt(oldAcl, offset + 8, sidPtr, 0)) return true;
    offset += aceSize;
  }
  return false;
}

/** Grant GRANT_MASK (Write+Delete, "Modify") to the capability SID on `path`, inheriting to subcontainers and objects. Idempotent; runs under the per-path lock. */
export function grantWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): void {
  withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentDacl(api, path);
    if (oldAcl !== null && hasExactGrant(oldAcl, sidPtr)) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor);
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `grantWrite(${path}) descriptor`);
      }
      return;
    }
    mergeAndApply(
      api,
      path,
      buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.GRANT_MASK),
      oldAcl,
      descriptor,
      'grantWrite'
    );
  });
}

/** Remove every ACE for the capability SID from the directory DACL. Runs under the per-path lock. */
export function revokeWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): boolean {
  return withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentDacl(api, path);
    if (oldAcl === null) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor);
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `revokeWrite(${path}) descriptor`);
      }
      return false;
    }
    mergeAndApply(api, path, buildExplicitAccess(sidPtr, abi.REVOKE_ACCESS, 0), oldAcl, descriptor, 'revokeWrite');
    return true;
  });
}

/**
 * One workspace's write grant: parse the SID string, grant the write ACE on the
 * workspace root, and expose {@link dispose} to revoke it. Fail-closed: `create`
 * or `grant` throwing means nothing (or a half-applied ACE the caller disposes)
 * is left writable.
 */
export class WorkspaceWriteGrant {
  private disposed = false;

  private constructor(
    private readonly api: Win32Bindings,
    private readonly sidPtr: NativePtr,
    private readonly grantedPaths: string[]
  ) {}

  /**
   * Parse `writeSid` and grant the write ACE on `workspaceRoot`.
   * @param writeSid - the workspace capability SID (`S-1-4-x-y`).
   * @param workspaceRoot - the directory whose DACL gains the grant.
   * @param api - optional already-resolved bindings (tests).
   */
  static create(writeSid: string, workspaceRoot: string, api?: Win32Bindings): WorkspaceWriteGrant {
    const bindings = api ?? win32();
    const sidSlot = allocPtrSlot();
    if (bindings.convertStringSidToSidW(writeSid, sidSlot) === 0)
      throwLastError(bindings, 'ConvertStringSidToSidW', writeSid);
    const sidPtr = decodePtr(sidSlot);
    if (sidPtr === null) throwLastError(bindings, 'ConvertStringSidToSidW', `null SID for ${writeSid}`);
    const grant = new WorkspaceWriteGrant(bindings, sidPtr, []);
    grant.grantedPaths.push(workspaceRoot);
    grantWrite(bindings, workspaceRoot, sidPtr);
    return grant;
  }

  /** The parsed capability SID (for the restricting-list token construction). */
  get sid(): NativePtr {
    return this.sidPtr;
  }

  /** Revoke every granted ACE and free the SID. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failures: unknown[] = [];
    for (const path of this.grantedPaths) {
      try {
        revokeWrite(this.api, path, this.sidPtr);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      const freed = this.api.localFree(this.sidPtr);
      if (!isNullPtr(freed)) throwLastError(this.api, 'LocalFree', 'workspace write SID');
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `WorkspaceWriteGrant dispose completed with ${failures.length} cleanup failure(s)`
      );
    }
  }
}
