/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Restricted-token FFI-shape tests. The koffi allocation/decoding helpers are
 * mocked so the token-construction logic (flag word, restricting-list size,
 * fail-closed on a null/failed token) is exercised WITHOUT Win32 — the real ABI
 * was already smoke-tested inside Electron.
 *
 * Mutation coverage is called out inline.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createRestrictedToken } from '@process/services/sandbox/restrictedToken';
import * as abi from '@process/services/sandbox/win32Constants';
import type { NativePtr, Win32Bindings } from '@process/services/sandbox/win32Bindings';

// A fixed non-null token the mocked decodePtr returns for the CreateRestrictedToken out-slot.
const FAKE_TOKEN = BigInt(0xabcd);

// vi.mock is hoisted above the imports above, so the static `createRestrictedToken`
// import already sees these inert helpers.
vi.mock('@process/services/sandbox/win32Bindings', async (importActual) => {
  const actual = await importActual<typeof import('@process/services/sandbox/win32Bindings')>();
  return {
    ...actual,
    // Allocation/decoding helpers become inert: token construction only cares
    // about the arguments it passes to CreateRestrictedToken, which we spy on.
    allocPtrSlot: (): NativePtr => BigInt(999) as unknown as NativePtr,
    allocBytes: (): NativePtr => BigInt(1) as unknown as NativePtr,
    allocUint32: (): NativePtr => BigInt(2) as unknown as NativePtr,
    encodeUint32: (): void => undefined,
    decodeUint32: (): number => 0,
    decodePtr: (): NativePtr => FAKE_TOKEN as unknown as NativePtr,
    ptrAddress: (p: bigint): bigint => p, // a fake NativePtr is already a bigint address
  };
});

const CURRENT = BigInt(10) as unknown as NativePtr;
const LOGON = BigInt(11) as unknown as NativePtr;
const WORLD = BigInt(12) as unknown as NativePtr;
const WRITE_SID = BigInt(13) as unknown as NativePtr;

const EXPECTED_FLAGS = abi.DISABLE_MAX_PRIVILEGE | abi.LUA_TOKEN | abi.WRITE_RESTRICTED; // 0xd

function makeApi(createResult: number): Win32Bindings {
  return {
    createRestrictedToken: vi.fn(() => createResult),
    getLastError: () => 0,
  } as unknown as Win32Bindings;
}

describe('createRestrictedToken flag word', () => {
  it('always requests DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED', () => {
    const api = makeApi(1);
    createRestrictedToken(api, CURRENT, LOGON, WORLD, [], 'read-only');
    const flags = (api.createRestrictedToken as unknown as Mock).mock.calls[0][1];
    // MUTATION: dropping WRITE_RESTRICTED (0x8) here silently disables the whole
    // sandbox — the token would no longer intersect writes with the ACL grants.
    expect(flags).toBe(EXPECTED_FLAGS);
    expect(flags & abi.WRITE_RESTRICTED).toBe(abi.WRITE_RESTRICTED);
  });
});

describe('createRestrictedToken restricting-list size', () => {
  it('read-only builds a 2-entry restricting list (logon, world)', () => {
    const api = makeApi(1);
    createRestrictedToken(api, CURRENT, LOGON, WORLD, [], 'read-only');
    const restrictCount = (api.createRestrictedToken as unknown as Mock).mock.calls[0][6];
    expect(restrictCount).toBe(2);
  });

  it('workspace-write with one write SID builds a 3-entry list (logon, world, write)', () => {
    const api = makeApi(1);
    createRestrictedToken(api, CURRENT, LOGON, WORLD, [WRITE_SID], 'workspace-write');
    const restrictCount = (api.createRestrictedToken as unknown as Mock).mock.calls[0][6];
    expect(restrictCount).toBe(3);
  });

  it('workspace-write with NO write SID throws before calling CreateRestrictedToken (fail-closed)', () => {
    const api = makeApi(1);
    // MUTATION: building a read-only token here instead of throwing would give a
    // caller a token it believes is workspace-writable but is not.
    expect(() => createRestrictedToken(api, CURRENT, LOGON, WORLD, [], 'workspace-write')).toThrow(
      /at least one write SID/i
    );
    expect(api.createRestrictedToken).not.toHaveBeenCalled();
  });
});

describe('createRestrictedToken fail-closed on API failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when CreateRestrictedToken returns 0 — never returns an unrestricted token', () => {
    const api = makeApi(0); // 0 = BOOL failure
    // MUTATION: swallowing the failure and returning the current token would run
    // the child FULLY UNRESTRICTED — this asserts the throw instead.
    expect(() => createRestrictedToken(api, CURRENT, LOGON, WORLD, [], 'read-only')).toThrow(/CreateRestrictedToken/);
  });
});
