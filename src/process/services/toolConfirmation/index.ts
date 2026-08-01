/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lifecycle for the single tool-confirmation gate, and its Electron wiring.
 *
 * Started from `initStorage()` alongside the personal-data server. Two things
 * happen at start:
 *
 *  1. The loopback listener binds, so spawned MCP subprocesses can reach it.
 *  2. Its port and per-boot token are written into the MAIN PROCESS's own
 *     `process.env`.
 *
 * Step 2 is the wiring, and it is deliberate. A gated MCP server is not always
 * spawned by us: an agent CLI (claude / gemini / codex) reads a config file and
 * spawns it itself, several layers down. Those layers all inherit the parent
 * environment, so putting the two variables in `process.env` reaches every
 * spawn path at once, including ones added later. The alternative - threading
 * the pair through all eleven `resolveBuiltinMcpSpawnArgs` call sites - is
 * eleven places for a future agent integration to forget, and forgetting there
 * is silent: the tool would simply refuse forever with `not-available`.
 *
 * Neither value is persisted. Both change every boot, so nothing stale can be
 * left in `mcp.config` pointing at a closed socket.
 */

import { app, BrowserWindow } from 'electron';
import { ipcBridge } from '@/common';
import { ToolConfirmationService } from './ToolConfirmationService';
import { ToolConfirmationTcpServer, type ToolConfirmationRuntime } from './ToolConfirmationTcpServer';
import { TOOL_CONFIRM_PORT_ENV, TOOL_CONFIRM_TOKEN_ENV } from './types';

export { ToolConfirmationService } from './ToolConfirmationService';
export { ToolConfirmationTcpServer } from './ToolConfirmationTcpServer';
export type { ToolConfirmationRuntime } from './ToolConfirmationTcpServer';
export * from './types';

let service: ToolConfirmationService | null = null;
let tcpServer: ToolConfirmationTcpServer | null = null;
let runtime: ToolConfirmationRuntime | null = null;
let lifecycleHooked = false;

/**
 * The in-process gate, created on first use.
 *
 * Available even when the loopback listener failed to bind: an in-process
 * caller (a future main-process tool) still gets a working dialog, and only
 * the subprocess bridge is lost.
 */
export function getToolConfirmationService(): ToolConfirmationService {
  service ??= new ToolConfirmationService({
    hasWindow: () => BrowserWindow.getAllWindows().some((win) => !win.isDestroyed()),
    emitRequest: (request) => ipcBridge.toolConfirmation.request.emit(request),
    emitCancel: (requestId) => ipcBridge.toolConfirmation.cancel.emit({ requestId }),
  });
  return service;
}

/** Start the loopback listener and publish its address to child processes. */
export async function initToolConfirmationGate(): Promise<ToolConfirmationRuntime | null> {
  if (runtime) return runtime;
  try {
    tcpServer = new ToolConfirmationTcpServer(getToolConfirmationService());
    runtime = await tcpServer.start();
    process.env[TOOL_CONFIRM_PORT_ENV] = String(runtime.port);
    process.env[TOOL_CONFIRM_TOKEN_ENV] = runtime.token;
    registerLifecycleHooks();
    console.log(`[ToolConfirmationGate] listening on 127.0.0.1:${runtime.port}`);
    return runtime;
  } catch (error) {
    // Not fatal, and not silent either: every gated tool will now refuse with
    // `not-available`, which is the correct answer when no one can be asked.
    console.error('[ToolConfirmationGate] failed to start - gated tools will refuse:', error);
    tcpServer = null;
    runtime = null;
    return null;
  }
}

/**
 * Deny outstanding dialogs when the app is going away or the last window has.
 *
 * A dialog dies with the window that drew it. Without these hooks the tool
 * blocked on it would wait out the full timeout against a dialog nobody can
 * see - the user closed the window, so the honest answer is "nothing was done",
 * immediately. `once` on quit, `on` for window-all-closed: on macOS the app
 * survives its last window and may open another.
 */
function registerLifecycleHooks(): void {
  if (lifecycleHooked) return;
  lifecycleHooked = true;
  app?.once?.('before-quit', () => {
    service?.shutdown();
  });
  app?.on?.('window-all-closed', () => {
    service?.denyAllPending(
      'no-window',
      'The Дархай window was closed before the confirmation was answered, so nothing was done.'
    );
  });
}

/** Port + token of the running gate, or null when it is not up. */
export function getToolConfirmationRuntime(): ToolConfirmationRuntime | null {
  return runtime;
}

/**
 * Deny everything outstanding and stop listening (app quit / test teardown).
 *
 * The shutdown call comes first on purpose: a tool blocked on a dialog must be
 * told "nothing was done" rather than left holding a promise against a socket
 * that is about to close.
 */
export async function stopToolConfirmationGate(): Promise<void> {
  service?.shutdown();
  await tcpServer?.stop();
  tcpServer = null;
  runtime = null;
  service = null;
  delete process.env[TOOL_CONFIRM_PORT_ENV];
  delete process.env[TOOL_CONFIRM_TOKEN_ENV];
}
