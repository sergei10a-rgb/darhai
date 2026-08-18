/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Restricted-token construction, ported from the deepseek-harness windows-acl
 * `token.ts`. Open the current process token, extract its logon SID, build the
 * well-known Everyone SID, and call CreateRestrictedToken with the
 * mode-selected restricting-SID allowlist. Every API call is checked; any
 * failure throws with the API name and the exact Win32 code — never spawn under
 * an unrestricted token.
 *
 * @module @process/services/sandbox/restrictedToken
 */

import { buildExplicitAccess } from './aclGrant';
import type { ConfinedSandboxMode } from './types';
import {
  allocBytes,
  allocPtrSlot,
  allocUint32,
  decodePtr,
  decodePtrAt,
  decodeUint32,
  encodeUint32,
  isNullPtr,
  ptrAddress,
  throwLastError,
  throwWin32,
} from './win32Bindings';
import type { NativePtr, Win32Bindings } from './win32Bindings';
import * as abi from './win32Constants';

/**
 * Decide the restricting-SID allowlist for a confined mode, as a symbolic plan
 * (pure — no FFI). This is the security-critical decision the token layer makes
 * and the one the mutation tests pin:
 *
 *  - `read-only`:       [logon, world] — NO write SID, so a standing workspace
 *    ACE from a previous workspace-write period stays INERT (WRITE_RESTRICTED
 *    pass-2 grants only what the restricting list carries).
 *  - `workspace-write`: [logon, world, ...write SIDs] — the write SIDs join the
 *    list so the confined child can write the workspace tree that carries their
 *    grant ACEs. At least one write SID is REQUIRED; an empty list throws rather
 *    than silently producing a read-only token that a caller believes is
 *    writable.
 *
 * `logon` + `world` (Everyone) are the shared keep-alive group both modes need:
 * without them early DLL init and CNG fail and the child dies at startup.
 *
 * @param mode - the confined mode selecting the list.
 * @param writeSidCount - how many distinct write SIDs the workspace-write grant carries.
 * @returns the symbolic restricting-list entries in order.
 */
export function restrictingSidPlan(
  mode: ConfinedSandboxMode,
  writeSidCount: number
): Array<'logon' | 'world' | 'write'> {
  if (mode === 'read-only') return ['logon', 'world'];
  if (writeSidCount <= 0) {
    throw new Error(
      'restrictingSidPlan: workspace-write requires at least one write SID (refusing to build a silently read-only token)'
    );
  }
  return ['logon', 'world', ...Array.from({ length: writeSidCount }, () => 'write' as const)];
}

/**
 * Open the current process's access token with the rights
 * CreateRestrictedToken requires. The token is obtained through a real
 * OpenProcess handle because the GetCurrentProcess pseudo-handle is not
 * addressable through koffi.
 */
export function openCurrentProcessToken(api: Win32Bindings): NativePtr {
  const processHandle = api.openProcess(abi.PROCESS_QUERY_INFORMATION, 0, process.pid);
  if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess', `pid ${process.pid}`);

  const tokenSlot = allocPtrSlot();
  const opened = api.openProcessToken(
    processHandle,
    abi.TOKEN_QUERY | abi.TOKEN_DUPLICATE | abi.TOKEN_ADJUST_DEFAULT | abi.TOKEN_ASSIGN_PRIMARY,
    tokenSlot
  );
  if (opened === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(processHandle);
    throwWin32(api, 'OpenProcessToken', win32Code, `pid ${process.pid}`);
  }
  if (api.closeHandle(processHandle) === 0) throwLastError(api, 'CloseHandle', 'OpenProcess process handle');
  const token = decodePtr(tokenSlot);
  if (token === null) throwWin32(api, 'OpenProcessToken', api.getLastError(), 'null token handle');
  return token;
}

/**
 * Find and copy the token's logon session SID (attribute SE_GROUP_LOGON_ID).
 * The restricted token needs it for WinSta0/desktop and other per-logon objects.
 */
export function findLogonSid(api: Win32Bindings, token: NativePtr): NativePtr {
  const neededSlot = allocUint32();
  api.getTokenInformation(token, abi.TokenGroups, null, 0, neededSlot); // expected ERROR_INSUFFICIENT_BUFFER
  const needed = decodeUint32(neededSlot);
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenGroups size query');
  if (needed < abi.TOKEN_GROUPS_OFFSET)
    throwWin32(api, 'GetTokenInformation', api.getLastError(), `implausible TokenGroups size ${needed}`);

  const groups = Buffer.alloc(needed);
  if (api.getTokenInformation(token, abi.TokenGroups, groups, groups.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenGroups');
  }
  const groupCount = groups.readUInt32LE(0);
  for (let index = 0; index < groupCount; index++) {
    const sidPtr = decodePtrAt(groups, abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE);
    const attributes = groups.readUInt32LE(abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE + 8);
    // >>> 0: JS bitwise & is signed 32-bit; SE_GROUP_LOGON_ID has bit 31 set.
    const isLogonId = (attributes & abi.SE_GROUP_LOGON_ID) >>> 0 === abi.SE_GROUP_LOGON_ID >>> 0;
    if (sidPtr === null || !isLogonId) continue;
    const sidLength = api.getLengthSid(sidPtr);
    if (sidLength === 0) throwLastError(api, 'GetLengthSid', `logon SID group ${index}`);
    const copy = allocBytes(sidLength);
    if (api.copySid(sidLength, copy, sidPtr) === 0) throwLastError(api, 'CopySid', `logon SID group ${index}`);
    return copy;
  }
  throw new Error(`CreateRestrictedToken prerequisite failed: no logon SID found among ${groupCount} token groups`);
}

/** Create one well-known SID (68-byte buffer) and assert its validity. */
export function makeWellKnownSid(api: Win32Bindings, type: number): NativePtr {
  const sid = allocBytes(abi.SECURITY_MAX_SID_SIZE);
  const sizeSlot = allocUint32();
  encodeUint32(sizeSlot, abi.SECURITY_MAX_SID_SIZE);
  if (api.createWellKnownSid(type, null, sid, sizeSlot) === 0)
    throwLastError(api, 'CreateWellKnownSid', `type ${type}`);
  if (api.isValidSid(sid) === 0) throwLastError(api, 'IsValidSid', `CreateWellKnownSid type ${type}`);
  return sid;
}

/**
 * Merge one full-access allow ACE for `sidPtr` into the token's DEFAULT DACL —
 * the DACL every NEW object the token holder creates (e.g. the child's stdio
 * pipes) takes. Without a restricting-SID ACE here, new anonymous pipes fail
 * the WRITE_RESTRICTED pass-2 check at creation (spawn EPERM). Fails closed:
 * any Win32 failure throws before the spawn.
 */
export function setTokenDefaultDaclGrant(api: Win32Bindings, token: NativePtr, sidPtr: NativePtr): void {
  const neededSlot = allocUint32();
  api.getTokenInformation(token, abi.TokenDefaultDacl, null, 0, neededSlot); // expected ERROR_INSUFFICIENT_BUFFER
  const needed = decodeUint32(neededSlot);
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl size query');
  const buffer = Buffer.alloc(needed);
  if (api.getTokenInformation(token, abi.TokenDefaultDacl, buffer, buffer.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl');
  }
  const currentDacl = decodePtrAt(buffer, 0);
  if (currentDacl === null) throw new Error('setTokenDefaultDaclGrant: the token carries no default DACL to extend');

  const newDaclSlot = allocPtrSlot();
  const result = api.setEntriesInAclW(
    1,
    buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.FILE_ALL_ACCESS),
    currentDacl,
    newDaclSlot
  );
  if (result !== abi.ERROR_SUCCESS) throwWin32(api, 'SetEntriesInAclW', result, 'default DACL merge');
  const newDacl = decodePtr(newDaclSlot);
  if (newDacl === null) throwWin32(api, 'SetEntriesInAclW', result, 'null merged default DACL');
  // TOKEN_DEFAULT_DACL is exactly the ACL pointer; SetTokenInformation copies it.
  const info = Buffer.alloc(8);
  info.writeBigUInt64LE(newDacl as unknown as bigint, 0);
  if (api.setTokenInformation(token, abi.TokenDefaultDacl, info, info.length) === 0) {
    const win32Code = api.getLastError();
    api.localFree(newDacl);
    throwWin32(api, 'SetTokenInformation', win32Code, 'TokenDefaultDacl');
  }
  api.localFree(newDacl);
}

/** Pack `SID_AND_ATTRIBUTES[count]` (16-byte stride; Attributes stay 0). */
function buildRestrictingSids(sids: readonly NativePtr[]): Buffer {
  const buffer = Buffer.alloc(abi.SID_AND_ATTRIBUTES_SIZE * sids.length);
  sids.forEach((sid, index) => {
    buffer.writeBigUInt64LE(ptrAddress(sid), abi.SID_AND_ATTRIBUTES_SIZE * index);
  });
  return buffer;
}

/**
 * Create the write-restricted token with the mode-selected restricting list
 * (see {@link restrictingSidPlan}). Uses DISABLE_MAX_PRIVILEGE | LUA_TOKEN |
 * WRITE_RESTRICTED. FAILS CLOSED: any failure throws — never returns an
 * unrestricted token.
 *
 * @param mode - the confined mode selecting the restricting list.
 * @returns the restricted token handle.
 */
export function createRestrictedToken(
  api: Win32Bindings,
  currentToken: NativePtr,
  logonSid: NativePtr,
  world: NativePtr,
  writeSids: readonly NativePtr[],
  mode: ConfinedSandboxMode
): NativePtr {
  const plan = restrictingSidPlan(mode, writeSids.length);
  let writeIndex = 0;
  const restricting = plan.map((entry) => {
    if (entry === 'logon') return logonSid;
    if (entry === 'world') return world;
    return writeSids[writeIndex++];
  });
  const restrictingSids = buildRestrictingSids(restricting);
  const tokenSlot = allocPtrSlot();
  const created = api.createRestrictedToken(
    currentToken,
    abi.DISABLE_MAX_PRIVILEGE | abi.LUA_TOKEN | abi.WRITE_RESTRICTED,
    0,
    null,
    0,
    null,
    restricting.length,
    restrictingSids,
    tokenSlot
  );
  if (created === 0) throwLastError(api, 'CreateRestrictedToken', `restricting SIDs: ${restricting.length}`);
  const token = decodePtr(tokenSlot);
  if (token === null) throwWin32(api, 'CreateRestrictedToken', api.getLastError(), 'null token handle');
  return token;
}
