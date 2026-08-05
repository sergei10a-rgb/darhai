/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Recognise a permission prompt that belongs to Darhai's own team MCP server.
 *
 * Team tools are how the app coordinates its own agents - spawning a teammate,
 * passing a message between them. They are not the user's tools and there is
 * nobody to ask, so they are approved automatically. Failing to recognise one
 * does not fall back to a prompt the user can answer: the call simply waits.
 * That is what "adding a codex teammate hangs forever" was.
 *
 * The claude and gemini bridges put the server name in the prompt title, which
 * the title check below has always caught. codex-acp does not: its title is the
 * generic "Approve MCP tool call" and the server lives in `rawInput.server_name`.
 * So a team call through codex matched nothing and sat there.
 */

const TEAM_MCP_SERVER_PREFIX = 'wayland-team-';

/** Just the fields this decision reads, so callers need not pass a whole request. */
export type TeamPermissionToolCall = {
  title?: string;
  rawInput?: Record<string, unknown>;
};

/**
 * True when this permission prompt is for a tool on the team MCP server.
 *
 * Two independent signals, because two bridges report it in different places:
 *
 *  - the title contains the server name (claude, gemini)
 *  - `rawInput.server_name` IS the server, prefix-anchored (codex)
 *
 * The `server_name` test is anchored deliberately. The title test is a substring
 * match, which is looser than one would choose today - but it is what the
 * working bridges are matched against, and tightening it without a real title
 * to check against would risk breaking the coordination that does work.
 */
export function isTeamMcpPermission(toolCall: TeamPermissionToolCall | undefined): boolean {
  if (!toolCall) return false;

  if ((toolCall.title || '').includes('wayland-team')) return true;

  const serverName = toolCall.rawInput?.server_name;
  return typeof serverName === 'string' && serverName.startsWith(TEAM_MCP_SERVER_PREFIX);
}
