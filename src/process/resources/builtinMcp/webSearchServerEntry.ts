/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stdio MCP subprocess entrypoint for the `web_search` tool.
 *
 * Bundled by `scripts/build-mcp-servers.js` into
 * `out/main/builtin-mcp-web-search.js`, packaged as `app.asar.unpacked`, and
 * spawned by ACP/Gemini/wcore agent sessions via `mcp.config`.
 *
 * It exposes ONE tool, `web_search`, that queries whichever search provider has
 * a configured API key (resolved from the encrypted tool-key store and
 * forwarded into this subprocess's env at registration time) and returns ranked
 * results as `{title, url, snippet}`.
 *
 * Failure handling is total: a missing provider key surfaces as a typed MCP
 * error, and any transient fetch failure is caught and returned as `isError`
 * text - the subprocess never crashes the caller.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BUILTIN_WEB_SEARCH_NAME, BUILTIN_WEB_SEARCH_TOOL_NAME } from './constants';
import { createWebSearchServer, MAX_WEB_SEARCH_COUNT, WebSearchConfigError } from './webSearchServer';

const TOOL_DESCRIPTION = `Search the public web for a natural-language query and return ranked results.

When to use:
- The user asks about current events, recent releases, prices, or anything that may have changed after your knowledge cutoff.
- You need an authoritative source URL to cite or to read next.

How it works:
- Queries the configured search backend using a key the app already manages (privacy-first: no query leaves the machine unless a key is configured).
- Returns up to \`count\` ranked results (default 5, max ${MAX_WEB_SEARCH_COUNT}). Each result has \`title\`, \`url\`, and a short \`snippet\`.

If no search key is configured, the tool returns a clear error telling the user to add one in Settings - it never fails silently.

Input:
- \`query\`: what to search for. Be specific.
- \`count\`: optional; max number of results (default 5, max ${MAX_WEB_SEARCH_COUNT}).`;

async function main(): Promise<void> {
  const server = new McpServer({
    name: BUILTIN_WEB_SEARCH_NAME,
    version: '1.0.0',
  });

  const handler = createWebSearchServer();

  server.tool(
    BUILTIN_WEB_SEARCH_TOOL_NAME,
    TOOL_DESCRIPTION,
    {
      query: z.string().describe('Natural-language search query. Be specific.'),
      count: z
        .number()
        .int()
        .positive()
        .max(MAX_WEB_SEARCH_COUNT)
        .optional()
        .describe(`Optional. Maximum number of results to return (default 5, max ${MAX_WEB_SEARCH_COUNT}).`),
    },
    async ({ query, count }) => {
      try {
        const result = await handler.call({ query, count });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        // Typed, provider-agnostic error text. Never leak keys or brand names.
        const message =
          error instanceof WebSearchConfigError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        return {
          content: [
            {
              type: 'text' as const,
              text: `web_search error: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[WebSearchMCP] Fatal error:', error);
  process.exit(1);
});
