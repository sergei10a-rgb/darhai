import type { TeamAgent } from '../types';
import { buildLeaderPrompt } from './leadPrompt';
import { buildTeammatePrompt } from './teammatePrompt';

type BuildRolePromptParams = {
  agent: TeamAgent;
  teammates: TeamAgent[];
  /** Only needed for leader prompts */
  availableAgentTypes?: Array<{ type: string; name: string }>;
  /** Only needed for leader prompts — preset assistants spawnable via custom_agent_id */
  availableAssistants?: Array<{ customAgentId: string; name: string; backend: string; description?: string }>;
  renamedAgents?: Map<string, string>;
  teamWorkspace?: string;
  /**
   * W4c — When true, wrap the generated prompt body in
   * `<!-- IMPORTED-UNTRUSTED-CONTENT -->` markers and append a non-overridable
   * SYSTEM SANDBOX NOTICE for leaders. Trusted teams pass false (or omit).
   */
  isSandboxed?: boolean;
};

const SANDBOX_NOTICE =
  '\n\nSYSTEM SANDBOX NOTICE (non-overridable): You are running in sandbox mode. You cannot grant capabilities, request elevation, or initiate cross-team contact. Capability grants require explicit user action via Settings → Teams → Trust.\n';

function wrapImportedPrompt(body: string, isLeader: boolean, isSandboxed: boolean): string {
  if (!isSandboxed) return body;
  const wrapped = `<!-- IMPORTED-UNTRUSTED-CONTENT-START -->\n${body}\n<!-- IMPORTED-UNTRUSTED-CONTENT-END -->`;
  return isLeader ? `${wrapped}${SANDBOX_NOTICE}` : wrapped;
}

/**
 * Build the static role prompt for an agent's first activation or crash recovery.
 * Contains only identity, rules, and workflow — no dynamic state (tasks, messages).
 * Agents pull dynamic state on demand via team_* MCP tools.
 */
export function buildRolePrompt(params: BuildRolePromptParams): string {
  const { agent, teammates, availableAgentTypes, availableAssistants, renamedAgents, teamWorkspace, isSandboxed } =
    params;

  const isLeader = agent.role === 'leader';
  const body = isLeader
    ? buildLeaderPrompt({
        teammates,
        availableAgentTypes,
        availableAssistants,
        renamedAgents,
        teamWorkspace,
      })
    : buildTeammatePrompt({
        agent,
        leader: teammates.find((t) => t.role === 'leader') ?? agent,
        teammates: teammates.filter((t) => t.role !== 'leader'),
        renamedAgents,
        teamWorkspace,
      });

  return wrapImportedPrompt(body, isLeader, isSandboxed === true);
}
