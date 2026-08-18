/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lazy koffi bindings for the Win32 ACL-sandbox backend, ported from the
 * deepseek-harness windows-acl `ffi.ts`. koffi loads lazily so non-Windows
 * processes never open Win32 libraries. Every function signature was verified
 * against the MinGW Windows headers and cross-checked by an ABI probe on
 * Windows 11 26200; struct layouts are asserted at load against the constants
 * in `win32Constants.ts`.
 *
 * The koffi ABI smoke test (kernel32 + advapi32 load, CreateRestrictedToken /
 * OpenProcessToken bind) was confirmed to work inside Darhai's Electron
 * 41.6.0 (Node 24, N-API 10) with koffi 3.1.5 before this module was written.
 *
 * @module @process/services/sandbox/win32Bindings
 */

import koffi from 'koffi';
import * as abi from './win32Constants';

/** A Win32 API failure carrying the API name and the exact Win32 error code. */
export class Win32Error extends Error {
  constructor(
    readonly api: string,
    readonly win32Code: number,
    detail: string
  ) {
    super(`${api} failed (Win32 error ${win32Code})${detail ? `: ${detail}` : ''}`);
    this.name = 'Win32Error';
  }
}

/** Branded koffi 3 native pointer (a BigInt address), kept out of numeric contexts. */
declare const nativePtr: unique symbol;
export type NativePtr = bigint & { readonly [nativePtr]: true };

/** All-ones 64-bit / INVALID_HANDLE_VALUE, as a BigInt (literal form unavailable below ES2020 target). */
const INVALID_HANDLE_BIGINT = BigInt('0xFFFFFFFFFFFFFFFF');
const ZERO_BIGINT = BigInt(0);
const NEG_ONE_BIGINT = BigInt(-1);

/** True for NULL pointers, however koffi returns them (null, undefined, or 0n). */
export function isNullPtr(value: NativePtr | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as bigint) === ZERO_BIGINT;
}

/** True for CreateFileW's INVALID_HANDLE_VALUE marker (-1 / unsigned all-ones). */
export function isInvalidHandle(handle: NativePtr | null | undefined): boolean {
  if (isNullPtr(handle)) return true;
  return (handle as bigint) === INVALID_HANDLE_BIGINT || (handle as bigint) === NEG_ONE_BIGINT;
}

type Ptr = ReturnType<typeof koffi.pointer>;

/** Field subset written into a zeroed STARTUPINFOW. */
export type StartupInfoInput = {
  cb: number;
  dwFlags: number;
  hStdInput: NativePtr;
  hStdOutput: NativePtr;
  hStdError: NativePtr;
};

/** Decoded PROCESS_INFORMATION. */
export type ProcessInfoOutput = {
  hProcess: NativePtr | null;
  hThread: NativePtr | null;
  dwProcessId: number;
  dwThreadId: number;
};

/** The lazy koffi binding table: every Win32 call the ACL backend uses. */
export interface Win32Bindings {
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr;
  openProcessToken(process: NativePtr, desiredAccess: number, tokenHandle: NativePtr): number;
  closeHandle(handle: NativePtr): number;
  getLastError(): number;
  formatMessageW(
    flags: number,
    source: null,
    messageId: number,
    languageId: number,
    buffer: Buffer,
    size: number,
    args: null
  ): number;
  localFree(memory: NativePtr): NativePtr;
  convertStringSidToSidW(stringSid: string, sid: NativePtr): number;
  createWellKnownSid(type: number, domainSid: null, sid: NativePtr, size: NativePtr): number;
  isValidSid(sid: NativePtr): number;
  getLengthSid(sid: NativePtr): number;
  copySid(length: number, destination: NativePtr, source: NativePtr): number;
  getTokenInformation(token: NativePtr, cls: number, info: Buffer | null, length: number, needed: NativePtr): number;
  setTokenInformation(token: NativePtr, cls: number, info: Buffer, length: number): number;
  createRestrictedToken(
    existing: NativePtr,
    flags: number,
    disableCount: number,
    disableSids: null,
    deletePrivilegeCount: number,
    privilegesToDelete: null,
    restrictCount: number,
    restrictingSids: Buffer,
    newToken: NativePtr
  ): number;
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAcl: NativePtr): number;
  setNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: null,
    group: null,
    dacl: NativePtr | null,
    sacl: null
  ): number;
  getNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: NativePtr,
    group: NativePtr,
    dacl: NativePtr,
    sacl: NativePtr,
    descriptor: NativePtr
  ): number;
  getTempPathW(length: number, buffer: Buffer): number;
  createFileW(
    fileName: string,
    desiredAccess: number,
    shareMode: number,
    attributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null
  ): NativePtr;
  lockFileEx(
    file: NativePtr,
    flags: number,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: NativePtr
  ): number;
  unlockFileEx(file: NativePtr, reserved: number, bytesLow: number, bytesHigh: number, overlapped: NativePtr): number;
  createPipe(readHandle: NativePtr, writeHandle: NativePtr, attributes: null, size: number): number;
  setHandleInformation(handle: NativePtr, mask: number, flags: number): number;
  createProcessAsUserW(
    token: NativePtr,
    applicationName: null,
    commandLine: string,
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: number,
    creationFlags: number,
    environment: null,
    currentDirectory: string | null,
    startupInfo: NativePtr,
    processInfo: NativePtr
  ): number;
  readFile(file: NativePtr, buffer: Buffer, count: number, bytesRead: NativePtr, overlapped: null): number;
  peekNamedPipe(
    pipe: NativePtr,
    buffer: null,
    size: number,
    bytesRead: NativePtr,
    totalAvail: NativePtr,
    leftThisMessage: NativePtr
  ): number;
  waitForSingleObject(handle: NativePtr, milliseconds: number): number;
  getExitCodeProcess(process: NativePtr, exitCode: NativePtr): number;
}

const PVOID: Ptr = koffi.pointer('void');
const PPVOID: Ptr = koffi.pointer(PVOID);

/** koffi STARTUPINFOW layout; size asserted against abi.STARTUPINFOW_SIZE at load. */
export const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'str16',
  lpDesktop: 'str16',
  lpTitle: 'str16',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: koffi.pointer('uint8'),
  hStdInput: PVOID,
  hStdOutput: PVOID,
  hStdError: PVOID,
});

/** koffi PROCESS_INFORMATION layout; size asserted against abi.PROCESS_INFORMATION_SIZE at load. */
export const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: PVOID,
  hThread: PVOID,
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
});

/** Allocate one pointer-sized slot (for `T **` out-parameters). */
export function allocPtrSlot(): NativePtr {
  return koffi.alloc(PVOID, 1) as unknown as NativePtr;
}

/** Allocate one uint32 slot. */
export function allocUint32(): NativePtr {
  return koffi.alloc('uint32', 1) as unknown as NativePtr;
}

/** Write a uint32 value into a slot pointer. */
export function encodeUint32(slot: NativePtr, value: number): void {
  koffi.encode(slot, 'uint32', value);
}

/** Decode the pointer stored in a pointer-sized slot (NULL becomes null). */
export function decodePtr(slot: NativePtr): NativePtr | null {
  const value = koffi.decode(slot, PVOID) as NativePtr | null | undefined;
  if (isNullPtr(value)) return null;
  return value as NativePtr;
}

/** Decode a uint32 at a slot pointer. */
export function decodeUint32(slot: NativePtr): number {
  return koffi.decode(slot, 'uint32') as number;
}

/** Cast a koffi pointer to its numeric address (bigint, for raw struct packing). */
export function ptrAddress(ptr: NativePtr): bigint {
  return koffi.address(ptr);
}

/** Allocate a raw byte block (SID copies and variable-length arrays). */
export function allocBytes(length: number): NativePtr {
  return koffi.alloc('uint8', length) as unknown as NativePtr;
}

/** Allocate one zeroed OVERLAPPED (32 bytes on x64). koffi crashes on NULL lpOverlapped; a zeroed one on a sync handle is the documented equivalent. */
export function allocOverlapped(): NativePtr {
  return allocBytes(32);
}

/** Decode a pointer VALUE stored at buffer[offset]. */
export function decodePtrAt(buffer: Buffer, offset: number): NativePtr | null {
  const value = koffi.decode(buffer, offset, PVOID) as NativePtr | null | undefined;
  if (isNullPtr(value)) return null;
  return value as NativePtr;
}

/** Decode a uint8 at a native pointer plus byte offset. */
export function decodeUint8At(ptr: NativePtr, offset: number): number {
  return koffi.decode(ptr, offset, 'uint8') as number;
}

/** Decode a uint16 at a native pointer plus byte offset. */
export function decodeUint16At(ptr: NativePtr, offset: number): number {
  return koffi.decode(ptr, offset, 'uint16') as number;
}

/** Decode a uint32 at a native pointer plus byte offset. */
export function decodeUint32At(ptr: NativePtr, offset: number): number {
  return koffi.decode(ptr, offset, 'uint32') as number;
}

/**
 * Compare two SIDs field-by-field via bounded offset reads (revision, count,
 * identifier authority, subauthorities up to the count) — never a fixed-size
 * struct decode, which would read past a short SID allocation.
 */
export function sameSidAt(left: NativePtr, leftOffset: number, right: NativePtr, rightOffset: number): boolean {
  if (decodeUint8At(left, leftOffset) !== decodeUint8At(right, rightOffset)) return false;
  const leftCount = decodeUint8At(left, leftOffset + 1);
  const rightCount = decodeUint8At(right, rightOffset + 1);
  if (leftCount !== rightCount || leftCount > abi.SID_MAX_SUB_AUTHORITIES) return false;
  for (let index = 0; index < 6; index++) {
    if (decodeUint8At(left, leftOffset + 2 + index) !== decodeUint8At(right, rightOffset + 2 + index)) return false;
  }
  for (let index = 0; index < leftCount; index++) {
    if (decodeUint32At(left, leftOffset + 8 + index * 4) !== decodeUint32At(right, rightOffset + 8 + index * 4))
      return false;
  }
  return true;
}

/** Allocate a zeroed STARTUPINFOW. */
export function allocStartupInfo(): NativePtr {
  return koffi.alloc(STARTUPINFOW, 1) as unknown as NativePtr;
}

/** Write the stdio-relevant fields into a zeroed STARTUPINFOW. */
export function encodeStartupInfo(startupInfo: NativePtr, fields: StartupInfoInput): void {
  koffi.encode(startupInfo, STARTUPINFOW, fields);
}

/** Allocate a zeroed PROCESS_INFORMATION. */
export function allocProcessInfo(): NativePtr {
  return koffi.alloc(PROCESS_INFORMATION, 1) as unknown as NativePtr;
}

/** Decode a PROCESS_INFORMATION after CreateProcessAsUserW. */
export function decodeProcessInfo(processInfo: NativePtr): ProcessInfoOutput {
  return koffi.decode(processInfo, PROCESS_INFORMATION) as ProcessInfoOutput;
}

/** Bind one `__stdcall` export by name (module-scoped: it captures nothing from win32()). */
function bindFn(
  lib: ReturnType<typeof koffi.load>,
  name: string,
  result: Ptr | string,
  args: Array<Ptr | string>
): unknown {
  return lib.func('__stdcall', name, result, args);
}

let cached: Win32Bindings | undefined;
let layoutChecked = false;

function assertLayout(): void {
  if (layoutChecked) return;
  if (STARTUPINFOW.size !== abi.STARTUPINFOW_SIZE) {
    throw new Error(`STARTUPINFOW layout mismatch: koffi ${STARTUPINFOW.size}, header ${abi.STARTUPINFOW_SIZE}`);
  }
  if (PROCESS_INFORMATION.size !== abi.PROCESS_INFORMATION_SIZE) {
    throw new Error(
      `PROCESS_INFORMATION layout mismatch: koffi ${PROCESS_INFORMATION.size}, header ${abi.PROCESS_INFORMATION_SIZE}`
    );
  }
  layoutChecked = true;
}

/**
 * Resolve the lazy Win32 bindings. Fail-closed: throws on any binding failure
 * (a missing library or a signature mismatch), never returns a partial table.
 * Throws immediately off Windows so a confined policy can never silently fall
 * through to an unconfined spawn.
 */
export function win32(): Win32Bindings {
  if (cached !== undefined) return cached;
  if (process.platform !== 'win32') {
    throw new Error('win32 bindings are only available on Windows (process.platform !== "win32")');
  }
  assertLayout();
  const kernel32 = koffi.load('kernel32.dll');
  const advapi32 = koffi.load('advapi32.dll');

  cached = {
    openProcess: bindFn(kernel32, 'OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    openProcessToken: bindFn(advapi32, 'OpenProcessToken', 'int', [PVOID, 'uint32', PPVOID]),
    closeHandle: bindFn(kernel32, 'CloseHandle', 'int', [PVOID]),
    getLastError: bindFn(kernel32, 'GetLastError', 'uint32', []),
    formatMessageW: bindFn(kernel32, 'FormatMessageW', 'uint32', [
      'uint32',
      PVOID,
      'uint32',
      'uint32',
      PVOID,
      'uint32',
      PVOID,
    ]),
    localFree: bindFn(kernel32, 'LocalFree', PVOID, [PVOID]),
    convertStringSidToSidW: bindFn(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', PPVOID]),
    createWellKnownSid: bindFn(advapi32, 'CreateWellKnownSid', 'int', ['int', PVOID, PVOID, koffi.pointer('uint32')]),
    isValidSid: bindFn(advapi32, 'IsValidSid', 'int', [PVOID]),
    getLengthSid: bindFn(advapi32, 'GetLengthSid', 'uint32', [PVOID]),
    copySid: bindFn(advapi32, 'CopySid', 'int', ['uint32', PVOID, PVOID]),
    getTokenInformation: bindFn(advapi32, 'GetTokenInformation', 'int', [
      PVOID,
      'int',
      PVOID,
      'uint32',
      koffi.pointer('uint32'),
    ]),
    setTokenInformation: bindFn(advapi32, 'SetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32']),
    createRestrictedToken: bindFn(advapi32, 'CreateRestrictedToken', 'int', [
      PVOID,
      'uint32',
      'uint32',
      PVOID,
      'uint32',
      PVOID,
      'uint32',
      PVOID,
      PPVOID,
    ]),
    setEntriesInAclW: bindFn(advapi32, 'SetEntriesInAclW', 'uint32', ['uint32', PVOID, PVOID, PPVOID]),
    setNamedSecurityInfoW: bindFn(advapi32, 'SetNamedSecurityInfoW', 'uint32', [
      'str16',
      'int',
      'uint32',
      PVOID,
      PVOID,
      PVOID,
      PVOID,
    ]),
    getNamedSecurityInfoW: bindFn(advapi32, 'GetNamedSecurityInfoW', 'uint32', [
      'str16',
      'int',
      'uint32',
      PPVOID,
      PPVOID,
      PPVOID,
      PPVOID,
      PPVOID,
    ]),
    getTempPathW: bindFn(kernel32, 'GetTempPathW', 'uint32', ['uint32', PVOID]),
    createFileW: bindFn(kernel32, 'CreateFileW', PVOID, [
      'str16',
      'uint32',
      'uint32',
      PVOID,
      'uint32',
      'uint32',
      PVOID,
    ]),
    lockFileEx: bindFn(kernel32, 'LockFileEx', 'int', [PVOID, 'uint32', 'uint32', 'uint32', 'uint32', PVOID]),
    unlockFileEx: bindFn(kernel32, 'UnlockFileEx', 'int', [PVOID, 'uint32', 'uint32', 'uint32', PVOID]),
    createPipe: bindFn(kernel32, 'CreatePipe', 'int', [PPVOID, PPVOID, PVOID, 'uint32']),
    setHandleInformation: bindFn(kernel32, 'SetHandleInformation', 'int', [PVOID, 'uint32', 'uint32']),
    createProcessAsUserW: bindFn(advapi32, 'CreateProcessAsUserW', 'int', [
      PVOID,
      'str16',
      'str16',
      PVOID,
      PVOID,
      'int',
      'uint32',
      PVOID,
      'str16',
      koffi.pointer(STARTUPINFOW),
      koffi.pointer(PROCESS_INFORMATION),
    ]),
    readFile: bindFn(kernel32, 'ReadFile', 'int', [PVOID, PVOID, 'uint32', koffi.pointer('uint32'), PVOID]),
    peekNamedPipe: bindFn(kernel32, 'PeekNamedPipe', 'int', [
      PVOID,
      PVOID,
      'uint32',
      koffi.pointer('uint32'),
      koffi.pointer('uint32'),
      koffi.pointer('uint32'),
    ]),
    waitForSingleObject: bindFn(kernel32, 'WaitForSingleObject', 'uint32', [PVOID, 'uint32']),
    getExitCodeProcess: bindFn(kernel32, 'GetExitCodeProcess', 'int', [PVOID, koffi.pointer('uint32')]),
  } as unknown as Win32Bindings;
  return cached;
}

/** Turn a Win32 error code into readable text via FormatMessageW ('' on failure). */
export function errorText(api: Win32Bindings, win32Code: number): string {
  const buffer = Buffer.alloc(1024);
  const length = api.formatMessageW(
    abi.FORMAT_MESSAGE_FROM_SYSTEM | abi.FORMAT_MESSAGE_IGNORE_INSERTS,
    null,
    win32Code,
    0,
    buffer,
    buffer.length / 2,
    null
  );
  if (length === 0) return '';
  return buffer
    .subarray(0, length * 2)
    .toString('utf16le')
    .trim();
}

/** Read the process temp directory via GetTempPathW (defensive against an overlong path). */
export function getTempPath(api: Win32Bindings): string {
  const buffer = Buffer.alloc((abi.MAX_PATH + 1) * 2);
  const length = api.getTempPathW(buffer.length / 2, buffer);
  if (length === 0) throwLastError(api, 'GetTempPathW');
  if (length > buffer.length / 2) {
    throw new Win32Error(
      'GetTempPathW',
      abi.ERROR_INSUFFICIENT_BUFFER,
      `required ${length} chars exceed the ${buffer.length / 2}-char buffer`
    );
  }
  return buffer.subarray(0, length * 2).toString('utf16le');
}

/** Throw a Win32Error for a BOOL-style API failure (call IMMEDIATELY after the failed call). */
export function throwLastError(api: Win32Bindings, name: string, detail?: string): never {
  const win32Code = api.getLastError();
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code));
}

/** Throw a Win32Error for an HRESULT-style return value (the value IS the error code). */
export function throwWin32(api: Win32Bindings, name: string, win32Code: number, detail?: string): never {
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code));
}
