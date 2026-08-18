/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Windows ABI constants for the ACL-restricted-token sandbox backend. Ported
 * from the deepseek-harness windows-acl backend (`win32-abi.ts`), whose values
 * were each verified against the real MinGW Windows headers and cross-checked
 * at runtime by a C++ ABI probe on Windows 11 build 26200. Only the subset the
 * restricted-token, spawn, and ACL-grant paths need is reproduced here.
 *
 * @module @process/services/sandbox/win32Constants
 */

// ---- TOKEN_* access rights (winnt.h) --------------------------------------
/** Required to create a process with the token (CreateProcessAsUserW). */
export const TOKEN_ASSIGN_PRIMARY = 0x0001;
/** Required to duplicate a token. */
export const TOKEN_DUPLICATE = 0x0002;
/** Required to read token information (GetTokenInformation). */
export const TOKEN_QUERY = 0x0008;
/** Required to change a token's default DACL. */
export const TOKEN_ADJUST_DEFAULT = 0x0080;

// ---- SID_AND_ATTRIBUTES.Attributes flags ----------------------------------
/** Marks a token-group SID as the logon SID (compared with `>>> 0`: bit 31 set). */
export const SE_GROUP_LOGON_ID = 0xc0000000;

// ---- generic file access (winnt.h) ----------------------------------------
/** STANDARD_RIGHTS_WRITE (== READ_CONTROL). */
export const STANDARD_RIGHTS_WRITE = 0x00020000;
/** FILE_GENERIC_WRITE: every file-write permission bit plus SYNCHRONIZE. */
export const FILE_GENERIC_WRITE = 0x00120116;
/** DELETE: remove or rename the object. */
export const DELETE = 0x00010000;
/** FILE_DELETE_CHILD: remove or rename a directory's children. */
export const FILE_DELETE_CHILD = 0x0040;
/**
 * Write+Delete access mask the capability-SID ACEs grant (displays as "Modify"
 * in icacls). WRITE_DAC/WRITE_OWNER are deliberately excluded: they would let a
 * confined child take ownership or rewrite DACLs and escape the allowlist.
 */
export const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE; // 0x00110156
/** FILE_ALL_ACCESS: full file-object access — the mask merged into the token's default DACL. */
export const FILE_ALL_ACCESS = 0x1f01ff;

// ---- CreateRestrictedToken flags (winnt.h) --------------------------------
/** Strip the token's maximum-privilege elevation so the confined child cannot escalate. */
export const DISABLE_MAX_PRIVILEGE = 0x1;
/** Produce a limited-user (filtered admin) token. */
export const LUA_TOKEN = 0x4;
/** Intersect write access with the restricting SIDs' ACL grants — the sandbox's core mechanism. */
export const WRITE_RESTRICTED = 0x8;

// ---- WELL_KNOWN_SID_TYPE ---------------------------------------------------
/** WinWorldSid: S-1-1-0 (Everyone). */
export const WinWorldSid = 1;

// ---- TOKEN_INFORMATION_CLASS ----------------------------------------------
/** TokenGroups: GetTokenInformation class returning the token's group SIDs. */
export const TokenGroups = 2;
/** TokenDefaultDacl: the DACL every NEW object created without an explicit SD takes. */
export const TokenDefaultDacl = 6;

// ---- SECURITY_INFORMATION --------------------------------------------------
/** DACL_SECURITY_INFORMATION: read/write only the DACL of a security descriptor. */
export const DACL_SECURITY_INFORMATION = 0x00000004;

// ---- PROCESS access rights -------------------------------------------------
/** PROCESS_QUERY_INFORMATION: read exit status/times of a process handle. */
export const PROCESS_QUERY_INFORMATION = 0x0400;

// ---- accctrl.h -------------------------------------------------------------
/** SE_FILE_OBJECT: the trustee path names a filesystem object. */
export const SE_FILE_OBJECT = 1;
/** TRUSTEE_IS_UNKNOWN. */
export const TRUSTEE_IS_UNKNOWN = 0;
/** TRUSTEE_IS_SID: Trustee.ptstrName is a SID pointer. */
export const TRUSTEE_IS_SID = 0;
/** NO_MULTIPLE_TRUSTEE. */
export const NO_MULTIPLE_TRUSTEE = 0;
/** GRANT_ACCESS: SetEntriesInAclW adds the entry as an allow ACE. */
export const GRANT_ACCESS = 1;
/** REVOKE_ACCESS: SetEntriesInAclW removes the matching allow ACE. */
export const REVOKE_ACCESS = 4;
/** SUB_CONTAINERS_AND_OBJECTS_INHERIT (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE). */
export const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3;

// ---- winbase.h -------------------------------------------------------------
/** STARTF_USESTDHANDLES: the child uses the hStd* handles (Node clears inheritance at startup). */
export const STARTF_USESTDHANDLES = 0x00000100;
/** HANDLE_FLAG_INHERIT: re-enable handle inheritance for the child's stdio handles. */
export const HANDLE_FLAG_INHERIT = 0x1;
/** INFINITE: never-timeout wait value. */
export const INFINITE = 0xffffffff;
/** MAX_PATH: legacy path length bound. */
export const MAX_PATH = 260;

// ---- FormatMessageW flags --------------------------------------------------
/** Format the message from the system message table. */
export const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000;
/** Skip insert-sequence substitution. */
export const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200;

// ---- error codes -----------------------------------------------------------
/** The operation succeeded. */
export const ERROR_SUCCESS = 0;
/** A size-probe call succeeded but needs a larger buffer. */
export const ERROR_INSUFFICIENT_BUFFER = 122;
/** The pipe's other end has closed. */
export const ERROR_BROKEN_PIPE = 109;
/** The pipe is being closed. */
export const ERROR_NO_DATA = 232;

// ---- lock files (fileapi.h / minwinbase.h) --------------------------------
/** GENERIC_READ: generic read access. */
export const GENERIC_READ = 0x80000000;
/** GENERIC_WRITE: generic write access. */
export const GENERIC_WRITE = 0x40000000;
/** FILE_SHARE_READ: other opens may read. */
export const FILE_SHARE_READ = 0x00000001;
/** FILE_SHARE_WRITE: other opens may write (lock files are shared read/write but NOT delete). */
export const FILE_SHARE_WRITE = 0x00000002;
/** OPEN_ALWAYS: create the lock file if absent, open it otherwise. */
export const OPEN_ALWAYS = 4;
/** LOCKFILE_EXCLUSIVE_LOCK: request an exclusive byte-range lock. */
export const LOCKFILE_EXCLUSIVE_LOCK = 0x2;

// ---- ACE_HEADER.AceType ----------------------------------------------------
/** An access-allowed ACE granting the mask to the trustee. */
export const ACCESS_ALLOWED_ACE_TYPE = 0;
/** The most subauthorities a SID may carry. */
export const SID_MAX_SUB_AUTHORITIES = 15;

// ---- ABI layout, verified by the deepseek-harness abi-probe (x64) ----------
/** SECURITY_MAX_SID_SIZE: maximum SID byte size. */
export const SECURITY_MAX_SID_SIZE = 68;
/** SID_AND_ATTRIBUTES stride: { PSID Sid @0 (8); DWORD Attributes @8 (4) } + pad. */
export const SID_AND_ATTRIBUTES_SIZE = 16;
/** TOKEN_GROUPS.Groups[] starts at offset 8 (GroupCount @0 + alignment). */
export const TOKEN_GROUPS_OFFSET = 8;
/** sizeof(EXPLICIT_ACCESS_W): perms@0 mode@4 inheritance@8 Trustee@16. */
export const EXPLICIT_ACCESS_W_SIZE = 48;
/** sizeof(STARTUPINFOW). */
export const STARTUPINFOW_SIZE = 104;
/** sizeof(PROCESS_INFORMATION). */
export const PROCESS_INFORMATION_SIZE = 24;
