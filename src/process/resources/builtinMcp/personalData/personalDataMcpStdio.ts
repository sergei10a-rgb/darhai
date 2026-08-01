/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stdio MCP subprocess entrypoint for the user's own data.
 *
 * Bundled by `scripts/build-mcp-servers.js` into
 * `out/main/builtin-mcp-personal-data.js`, packaged as `app.asar.unpacked`, and
 * spawned by every agent session that carries the `darhai-personal-data` entry
 * from `mcp.config`.
 *
 * This file is deliberately thin: it declares the tools and forwards each call
 * over loopback TCP to `PersonalDataMcpServer` in the Electron main process,
 * which owns the database, the local user row and the live services. See that
 * class for why the reads cannot happen here.
 *
 * Missing env is NOT fatal. The script still registers every tool and answers
 * `initialize` / `tools/list`, then reports a clear error at call time. Exiting
 * instead would make the shared build guard
 * (`tests/unit/process/utils/mcpScriptsBuilt.test.ts`) unable to tell a
 * configuration gap from a genuine bundle load failure, and would turn a
 * degraded feature into a dead server entry.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { sendTcpRequest } from '@process/team/mcp/tcpHelpers';
import { BUILTIN_PERSONAL_DATA_NAME, PERSONAL_DATA_PORT_ENV, PERSONAL_DATA_TOKEN_ENV } from '../constants';
import { PERSONAL_DATA_TOOLS } from './personalDataTools';

/** Per-call timeout. These are local reads; anything slower is a hang. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Total attempts per tool call.
 *
 * A loopback `connect` can fail transiently on a loaded host (observed as
 * `ETIMEDOUT 127.0.0.1:<port>` under a saturated Windows TCP stack, in this
 * server and in the pre-existing team MCP alike). Retrying is provably safe
 * HERE and only here: every tool on this server is a read, so a duplicated
 * request cannot double-apply anything. Do not copy this into a bridge that
 * gains a mutating verb.
 */
const MAX_ATTEMPTS = 3;
/** Backoff between attempts. Short - the failure mode is a stalled SYN, not load. */
const RETRY_DELAY_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const port = Number.parseInt(process.env[PERSONAL_DATA_PORT_ENV] ?? '0', 10);
const token = process.env[PERSONAL_DATA_TOKEN_ENV] ?? '';

const server = new McpServer({ name: BUILTIN_PERSONAL_DATA_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });

function errorResult(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

for (const spec of PERSONAL_DATA_TOOLS) {
  server.tool(spec.name, spec.description, spec.schema, async (args: Record<string, unknown>) => {
    if (!port || !token) {
      return errorResult(
        `${spec.name} is not available: the Darhai desktop app did not supply ${PERSONAL_DATA_PORT_ENV} / ` +
          `${PERSONAL_DATA_TOKEN_ENV}. Restart the app and try again.`
      );
    }
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await sendTcpRequest<{ result?: string; error?: string }>(
          port,
          { tool: spec.name, args, auth_token: token },
          { timeoutMs: REQUEST_TIMEOUT_MS }
        );
        // A server-side error is a real answer, not a transport failure -
        // return it rather than hammering the same bad request twice more.
        if (response.error) return errorResult(`${spec.name} error: ${response.error}`);
        return { content: [{ type: 'text' as const, text: response.result ?? '' }] };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS);
      }
    }
    return errorResult(`${spec.name} error after ${MAX_ATTEMPTS} attempts: ${lastError}`);
  });
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`[personal-data-mcp-stdio] Fatal error: ${err}\n`);
  process.exit(1);
});
