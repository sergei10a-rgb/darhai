// src/process/acp/session/McpConfig.ts
import type { IMcpServer } from '@/common/config/storage';
import type { AcpMcpCapabilities } from '@/common/types/acpTypes';
import type { McpServer } from '@agentclientprotocol/sdk';
import { shouldInjectMcpServer } from '@process/agent/acp/mcpSessionConfig';
import { resolveMcpStdioSpawn } from '@process/services/mcpServices/mcpStdioSpawn';

type MergeParams = {
  userServers?: McpServer[];
  presetServers?: McpServer[];
  teamServer?: McpServer;
};

/**
 * Default MCP capabilities used when no cached initialize result is available.
 * stdio is mandatory per ACP spec; http/sse are conservatively disabled.
 */
const DEFAULT_MCP_CAPABILITIES: AcpMcpCapabilities = { stdio: true, http: false, sse: false };

function toNameValueArray(source?: Record<string, string>): Array<{ name: string; value: string }> {
  if (!source) return [];
  return Object.entries(source)
    .filter(([n, v]) => typeof n === 'string' && typeof v === 'string')
    .map(([name, value]) => ({ name, value }));
}

// eslint-disable-next-line typescript-eslint/no-extraneous-class -- Static utility class matches project pattern
export class McpConfig {
  static merge(params: MergeParams): McpServer[] {
    const { userServers = [], presetServers = [], teamServer } = params;
    const merged = new Map<string, McpServer>();
    for (const s of presetServers) merged.set(s.name, s);
    for (const s of userServers) merged.set(s.name, s);
    const result = Array.from(merged.values());
    if (teamServer) result.push(teamServer);
    return result;
  }

  /**
   * Convert user-configured MCP servers (from ProcessConfig / IMcpServer[])
   * to SDK McpServer[] with transport capability filtering.
   *
   * Inclusion is decided by the shared `shouldInjectMcpServer` predicate:
   * builtin servers on `enabled`, user/catalog servers on `enabled` +
   * `connected`. Transport types unsupported by the agent are dropped.
   *
   * @param servers  Raw server configs from `ProcessConfig.get('mcp.config')`
   * @param capabilities  Agent MCP capabilities (from cached init result).
   *                      Defaults to stdio-only when not available.
   */
  static fromStorageConfig(servers: IMcpServer[], capabilities?: AcpMcpCapabilities): McpServer[] {
    const caps = capabilities ?? DEFAULT_MCP_CAPABILITIES;

    return servers
      .filter(shouldInjectMcpServer)
      .map((server): McpServer | null => {
        switch (server.transport.type) {
          case 'stdio': {
            if (!caps.stdio) return null;
            // A stored `npx` hint has to become a real command before the agent
            // spawns it, or on Windows the server starts nothing and the session
            // gets zero tools with no error.
            const spawn = resolveMcpStdioSpawn(server.transport.command, server.transport.args ?? []);
            return {
              name: server.name,
              command: spawn.command,
              args: spawn.args,
              env: toNameValueArray(server.transport.env),
            };
          }
          case 'http':
          case 'streamable_http':
            if (!caps.http) return null;
            return {
              type: 'http' as const,
              name: server.name,
              url: server.transport.url,
              headers: toNameValueArray(server.transport.headers),
            };
          case 'sse':
            if (!caps.sse) return null;
            return {
              type: 'sse' as const,
              name: server.name,
              url: server.transport.url,
              headers: toNameValueArray(server.transport.headers),
            };
          default:
            return null;
        }
      })
      .filter((s): s is McpServer => s !== null);
  }
}
