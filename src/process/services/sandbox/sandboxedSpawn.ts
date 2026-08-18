/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Restricted-process spawning, ported from the deepseek-harness windows-acl
 * `spawn.ts`. Anonymous pipes for stdio, STARTUPINFOW with STARTF_USESTDHANDLES,
 * CreateProcessAsUserW under the restricted token, then asynchronous pipe
 * draining and exit waiting. Console isolation (CREATE_NO_WINDOW) is
 * intentionally absent: under this restriction scheme hidden-console children
 * die with STATUS_DLL_INIT_FAILED (0xC0000142). Stdio redirection is pipe-based
 * and unaffected; the child shares the host console.
 *
 * @module @process/services/sandbox/sandboxedSpawn
 */

import {
  allocProcessInfo,
  allocPtrSlot,
  allocStartupInfo,
  allocUint32,
  decodeProcessInfo,
  decodePtr,
  decodeUint32,
  encodeStartupInfo,
  throwLastError,
  throwWin32,
} from './win32Bindings';
import type { NativePtr, Win32Bindings } from './win32Bindings';
import * as abi from './win32Constants';

/**
 * Quote one argument per the CommandLineToArgvW parsing rules: backslashes are
 * doubled only before a quote character — including the closing quote this
 * function appends. Mirrors the CRT ArgvQuote behavior.
 *
 * @param argument - one argv entry to quote.
 * @returns the quoted entry (bare when quoting is unnecessary).
 */
export function quoteArg(argument: string): string {
  if (argument === '') return '""';
  if (!/[\s"]/u.test(argument)) return argument;
  let quoted = '"';
  for (let index = 0; index < argument.length; index++) {
    let backslashes = 0;
    while (index < argument.length && argument.charAt(index) === '\\') {
      backslashes++;
      index++;
    }
    if (index === argument.length) {
      quoted += '\\'.repeat(backslashes * 2);
    } else if (argument.charAt(index) === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += '\\'.repeat(backslashes) + argument.charAt(index);
    }
  }
  return quoted + '"';
}

/** Build the single command line CreateProcess parses from program + argv. */
export function buildCommandLine(program: string, args: readonly string[]): string {
  return [program, ...args].map(quoteArg).join(' ');
}

type PipePair = { read: NativePtr; write: NativePtr };

function createPipe(api: Win32Bindings): PipePair {
  const readSlot = allocPtrSlot();
  const writeSlot = allocPtrSlot();
  if (api.createPipe(readSlot, writeSlot, null, 0) === 0) throwLastError(api, 'CreatePipe');
  const read = decodePtr(readSlot);
  const write = decodePtr(writeSlot);
  if (read === null || write === null) throwLastError(api, 'CreatePipe', 'null pipe handle');
  return { read, write };
}

function setInheritable(api: Win32Bindings, handle: NativePtr, label: string): void {
  if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
    throwLastError(api, 'SetHandleInformation', label);
  }
}

/** A confined child spawned with piped stdio: process handle plus the pipe read ends to drain. */
export type SpawnedNative = {
  pid: number;
  process: NativePtr;
  stdoutRead: NativePtr;
  stderrRead: NativePtr;
};

/**
 * Create a process under the restricted token with piped stdio. The child's
 * stdin read end is closed by the host immediately (EOF); stdout/stderr read
 * ends are returned for draining. The child inherits the caller's environment.
 * Fail-closed: any Win32 failure throws with all six pipe handles closed.
 *
 * @param api - the binding table.
 * @param token - the restricted token the child runs under.
 * @param options - command, args, and working directory.
 * @returns the spawned child's handles.
 */
export function spawnSandboxed(
  api: Win32Bindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string }
): SpawnedNative {
  const stdIn = createPipe(api);
  const stdOut = createPipe(api);
  const stdErr = createPipe(api);
  setInheritable(api, stdIn.read, 'stdin read end');
  setInheritable(api, stdOut.write, 'stdout write end');
  setInheritable(api, stdErr.write, 'stderr write end');

  const startupInfo = allocStartupInfo();
  encodeStartupInfo(startupInfo, {
    cb: abi.STARTUPINFOW_SIZE,
    dwFlags: abi.STARTF_USESTDHANDLES,
    hStdInput: stdIn.read,
    hStdOutput: stdOut.write,
    hStdError: stdErr.write,
  });

  const processInfo = allocProcessInfo();
  const commandLine = buildCommandLine(options.command, options.args);
  const created = api.createProcessAsUserW(
    token,
    null,
    commandLine,
    null,
    null,
    1,
    0,
    null,
    options.cwd,
    startupInfo,
    processInfo
  );
  if (created === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(stdIn.read);
    api.closeHandle(stdIn.write);
    api.closeHandle(stdOut.read);
    api.closeHandle(stdOut.write);
    api.closeHandle(stdErr.read);
    api.closeHandle(stdErr.write);
    throwWin32(api, 'CreateProcessAsUserW', win32Code, `command: ${options.command}, cwd: ${options.cwd}`);
  }

  const info = decodeProcessInfo(processInfo);
  const processHandle = info.hProcess;
  const threadHandle = info.hThread;
  if (processHandle === null || threadHandle === null) {
    throw new Error(
      `CreateProcessAsUserW succeeded but returned null process/thread handles (pid ${info.dwProcessId})`
    );
  }

  // Host-side cleanup: the child now owns duplicates of the child-side handles;
  // the host closes its copies so ReadFile sees EOF when the child exits.
  api.closeHandle(stdIn.read);
  api.closeHandle(stdOut.write);
  api.closeHandle(stdErr.write);
  api.closeHandle(stdIn.write);
  api.closeHandle(threadHandle);

  return { pid: info.dwProcessId, process: processHandle, stdoutRead: stdOut.read, stderrRead: stdErr.read };
}

/**
 * Drain one pipe read end to a Buffer via non-blocking PeekNamedPipe polling.
 * Closes the handle when done.
 */
export async function drainPipe(api: Win32Bindings, handle: NativePtr): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (;;) {
    const bytesReadSlot = allocUint32();
    const totalAvailSlot = allocUint32();
    const leftThisMessageSlot = allocUint32();
    const peeked = api.peekNamedPipe(handle, null, 0, bytesReadSlot, totalAvailSlot, leftThisMessageSlot);
    if (peeked === 0) {
      const win32Code = api.getLastError();
      if (win32Code === abi.ERROR_BROKEN_PIPE || win32Code === abi.ERROR_NO_DATA) break; // clean EOF
      throwLastError(api, 'PeekNamedPipe', `drain failure after ${chunks.length} chunk(s)`);
    }
    const available = decodeUint32(totalAvailSlot);
    if (available > 0) {
      const chunk = Buffer.alloc(available);
      const readSlot = allocUint32();
      if (api.readFile(handle, chunk, chunk.length, readSlot, null) === 0) {
        throwLastError(api, 'ReadFile', `drain failure after ${chunks.length} chunk(s)`);
      }
      chunks.push(chunk.subarray(0, decodeUint32(readSlot)));
    }
    // Small backoff instead of a next-tick busy-poll.
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  api.closeHandle(handle);
  return Buffer.concat(chunks);
}

/**
 * Wait for process exit and return its exit code. Call only after both drains
 * have resolved (the child has already exited), so this returns immediately.
 * Closes the process handle when done.
 */
export function waitForExit(api: Win32Bindings, process: NativePtr): number {
  const waitResult = api.waitForSingleObject(process, abi.INFINITE);
  if (waitResult === 0xffffffff) throwLastError(api, 'WaitForSingleObject');
  const exitCodeSlot = allocUint32();
  if (api.getExitCodeProcess(process, exitCodeSlot) === 0) throwLastError(api, 'GetExitCodeProcess');
  api.closeHandle(process);
  return decodeUint32(exitCodeSlot);
}
