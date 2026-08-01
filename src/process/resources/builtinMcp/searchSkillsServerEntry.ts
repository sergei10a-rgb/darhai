/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stdio MCP subprocess entrypoint for `darhai_search_skills`.
 *
 * Bundled by `scripts/build-mcp-servers.js` into
 * `out/main/builtin-mcp-search-skills.js`, packaged as `app.asar.unpacked`,
 * and spawned by ACP/Gemini/wcore agent sessions via `mcp.config`.
 *
 * The tool exposes the second channel of the two-channel skill architecture:
 * the native channel ships only `_builtin + pinned + enabledSkills`; the full
 * 2,105-entry library is reachable ONLY through this MCP tool.
 *
 * `SkillLibrary.loadBody` returns null for blocked entries, and this server
 * additionally filters them defensively before the body load (defense-in-depth).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BUILTIN_READ_SKILL_TOOL_NAME, BUILTIN_SEARCH_SKILLS_NAME, BUILTIN_SEARCH_SKILLS_TOOL_NAME } from './constants';
import { createSearchSkillsServer, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS } from './searchSkillsServer';

const SEARCH_TOOL_DESCRIPTION = `Search the full Darhai skill library (~2,470 entries) by natural-language query. Returns a RANKED LIST, not the skill contents.

When to use:
- The user's task hints at a domain not covered by the small set of skills already loaded in your context (those advertised in the system prompt).
- You need a specific recipe (e.g., "stripe webhook signing", "diff two PDFs", "git rebase recovery") that is not currently visible.

How it works:
- Lexical BM25 retrieval over titles + descriptions + tags + metadata.
- Returns up to \`limit\` ranked results (default 10, max 25). Each result has \`name\`, \`description\`, \`score\` and \`bodyChars\` (how large that skill's body is).
- Blocked or quarantined skills are NEVER returned.

Then call \`${BUILTIN_READ_SKILL_TOOL_NAME}\` with the \`name\` of the ONE skill you want. Read the descriptions first and pick deliberately - skill bodies average 24 KB and some are 59 KB, so fetching several without reason will crowd out the conversation you are having.

Input:
- \`query\`: natural-language description of what you are trying to do. Be specific.
- \`limit\`: optional; max number of results (default 10, max 25).`;

const READ_TOOL_DESCRIPTION = `Fetch the full markdown body of ONE skill by its exact \`name\`, as returned by \`${BUILTIN_SEARCH_SKILLS_TOOL_NAME}\`.

Use it after searching, for the single skill you decided you need. Treat the body as additional context: read it, follow its guidance, and cite the skill by \`name\` if relevant.

Names must match exactly - search first rather than guessing. Blocked or quarantined skills are never readable.`;

async function main(): Promise<void> {
  const server = new McpServer({
    name: BUILTIN_SEARCH_SKILLS_NAME,
    version: '1.0.0',
  });

  const handler = createSearchSkillsServer();

  /** Both tools answer with pretty JSON; failures answer with `isError` text. */
  const respond = async (toolName: string, run: () => Promise<unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await run(), null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `${toolName} error: ${message}` }], isError: true };
    }
  };

  server.tool(
    BUILTIN_SEARCH_SKILLS_TOOL_NAME,
    SEARCH_TOOL_DESCRIPTION,
    {
      query: z.string().describe('Natural-language description of the task or topic to find skills for.'),
      // Capped at 25, not 100. The old ceiling let one call ask for ~2.4 MB of
      // skill bodies; even as metadata, a 100-item list is a worse answer to
      // "which skill do I want" than a 10-item one. The server clamps this
      // again, so a caller ignoring the schema still cannot exceed it.
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_SEARCH_RESULTS)
        .optional()
        .describe(
          `Optional. Maximum number of results (default ${DEFAULT_SEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS}).`
        ),
    },
    async ({ query, limit }) => respond(BUILTIN_SEARCH_SKILLS_TOOL_NAME, () => handler.call({ query, limit }))
  );

  server.tool(
    BUILTIN_READ_SKILL_TOOL_NAME,
    READ_TOOL_DESCRIPTION,
    {
      name: z.string().describe('Exact skill name, as returned by the search tool.'),
    },
    async ({ name }) => respond(BUILTIN_READ_SKILL_TOOL_NAME, () => handler.readSkill({ name }))
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[SearchSkillsMCP] Fatal error:', error);
  process.exit(1);
});
