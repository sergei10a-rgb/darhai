/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lifecycle for the single {@link PersonalDataMcpServer} instance.
 *
 * Started from `initStorage()` immediately BEFORE `ensureBuiltinMcpServers()`,
 * because that function persists the spawn env (`port` + `token`) of the
 * `darhai-personal-data` entry into `mcp.config`. Starting later would seed a
 * port of 0 and every spawned bridge would report "not available" for the whole
 * session - the exact class of mute failure the MCP script canary exists to
 * prevent.
 *
 * `getPersonalDataMcpRuntime()` returns null until the server is up, and the
 * registration step skips the catalog entry in that case: an advert the model
 * cannot use is worse than no advert.
 */

import { PersonalDataMcpServer, type PersonalDataMcpRuntime } from './PersonalDataMcpServer';

let server: PersonalDataMcpServer | null = null;
let runtime: PersonalDataMcpRuntime | null = null;

/**
 * Start the personal-data MCP server if it is not already running.
 * Returns its runtime, or null when the loopback listener could not bind.
 */
export async function initPersonalDataMcpServer(): Promise<PersonalDataMcpRuntime | null> {
  if (runtime) return runtime;
  try {
    server = new PersonalDataMcpServer();
    runtime = await server.start();
    console.log(`[PersonalDataMcpServer] listening on 127.0.0.1:${runtime.port}`);
    return runtime;
  } catch (error) {
    console.error('[PersonalDataMcpServer] failed to start:', error);
    server = null;
    runtime = null;
    return null;
  }
}

/** Port + token of the running server, or null when it is not up. */
export function getPersonalDataMcpRuntime(): PersonalDataMcpRuntime | null {
  return runtime;
}

/** Stop the server (app quit / test teardown). */
export async function stopPersonalDataMcpServer(): Promise<void> {
  await server?.stop();
  server = null;
  runtime = null;
}
