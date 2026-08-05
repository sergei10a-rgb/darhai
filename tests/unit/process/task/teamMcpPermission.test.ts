/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Adding a codex teammate used to hang forever.
 *
 * Team MCP tools coordinate Darhai's own agents - spawning a teammate, passing
 * a message between them. There is nobody to ask about those, so they are
 * approved automatically. But failing to recognise one does not fall back to a
 * prompt the user can answer: the call just waits. The claude and gemini
 * bridges put the server name in the prompt title, which was matched; codex-acp
 * sends the generic "Approve MCP tool call" and puts the server in
 * `rawInput.server_name`, which was not.
 */

import { describe, expect, it } from 'vitest';
import { isTeamMcpPermission } from '@process/task/teamMcpPermission';

describe('isTeamMcpPermission', () => {
  it('recognises the codex shape, where the title says nothing', () => {
    // The regression, stated directly.
    expect(
      isTeamMcpPermission({
        title: 'Approve MCP tool call',
        rawInput: { server_name: 'wayland-team-abc', tool_name: 'team_spawn_agent' },
      })
    ).toBe(true);
  });

  it('still recognises the claude and gemini shape, where the title carries it', () => {
    expect(isTeamMcpPermission({ title: 'mcp__wayland-team-abc__team_spawn_agent' })).toBe(true);
    expect(isTeamMcpPermission({ title: 'wayland-team-abc - team_send_message' })).toBe(true);
  });

  it('leaves an ordinary tool to the user, which is the whole point of asking', () => {
    expect(isTeamMcpPermission({ title: 'Bash', rawInput: { command: 'rm -rf /' } })).toBe(false);
    expect(isTeamMcpPermission({ title: 'Approve MCP tool call', rawInput: { server_name: 'github' } })).toBe(false);
  });

  it('will not accept a server that merely starts similarly', () => {
    // `server_name` is anchored: an MCP server the user installed cannot pick a
    // name that ends in ours and inherit auto-approval.
    expect(isTeamMcpPermission({ rawInput: { server_name: 'evil-wayland-team-abc' } })).toBe(false);
    expect(isTeamMcpPermission({ rawInput: { server_name: 'wayland-teamwork' } })).toBe(false);
  });

  it('survives the shapes a bridge can actually send', () => {
    expect(isTeamMcpPermission(undefined)).toBe(false);
    expect(isTeamMcpPermission({})).toBe(false);
    expect(isTeamMcpPermission({ rawInput: {} })).toBe(false);
    expect(isTeamMcpPermission({ rawInput: { server_name: 42 as unknown as string } })).toBe(false);
  });
});
