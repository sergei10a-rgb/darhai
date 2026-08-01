/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent health check: drive a real `initialize` -> `session/new` ->
 * `session/prompt` round trip against a backend and report what happened.
 *
 * Every step here talks to a subprocess that we do not control. The previous
 * implementation awaited all three with no deadline, so a backend that accepted
 * the connection and then stalled left the IPC promise pending forever - the
 * functional audit measured `acp.check-agent-health` for goose still unresolved
 * after 180s, with nothing shown to the user. A health check that can hang is
 * worse than one that fails: the UI cannot distinguish it from "still working".
 *
 * The whole sequence therefore runs against a single wall-clock budget, and a
 * timeout is reported as a real, named failure (which phase ran out of time and
 * how long it had) rather than as a null result or a silent resolve.
 */

import { agentRegistry } from '@process/agent/AgentRegistry';
import { isAgentKind } from '@/common/types/detectedAgent';
import { LegacyConnectorFactory } from '@process/acp/compat/LegacyConnectorFactory';
import { noopProtocolHandlers } from '@process/acp/types';
import * as os from 'os';

/**
 * Wall-clock budget for the entire spawn + initialize + session + prompt round
 * trip. Sized from measurements on real backends: the slowest observed healthy
 * run on this class of machine was goose at ~43s (session/new 14s, prompt 29s)
 * and the claude npx bridge reported an auth failure at ~44s, so 90s leaves
 * roughly 2x headroom over the slowest known-good path while still bounding a
 * hang to something a user can wait out.
 */
export const HEALTH_CHECK_BUDGET_MS = 90_000;

/** A phase of the health-check sequence, used to name where a timeout landed. */
type HealthPhase = 'start' | 'session' | 'prompt';

/** Thrown when the budget runs out; carries the phase that was in flight. */
class HealthCheckTimeoutError extends Error {
  constructor(
    readonly phase: HealthPhase,
    readonly budgetMs: number
  ) {
    super(`timed out after ${budgetMs}ms while waiting for "${phase}"`);
    this.name = 'HealthCheckTimeoutError';
  }
}

/**
 * Race `work` against the remaining budget.
 *
 * The loser is not swallowed: on timeout the caller aborts the whole check and
 * closes the client, which rejects the still-pending request through
 * `ProcessAcpClient.rejectPendingRequests`.
 */
async function withDeadline<T>(work: Promise<T>, phase: HealthPhase, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new HealthCheckTimeoutError(phase, HEALTH_CHECK_BUDGET_MS);

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HealthCheckTimeoutError(phase, HEALTH_CHECK_BUDGET_MS)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type AgentHealthResult = {
  success: boolean;
  msg?: string;
  data?: { available: boolean; latency?: number; error?: string };
};

/** Error substrings that mean "the agent runs, it just is not signed in". */
const AUTH_ERROR_HINTS = ['auth', 'login', 'credential', 'api key', 'unauthorized', 'forbidden'] as const;

function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTH_ERROR_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Run a full ACP round trip against `backend` and report availability.
 *
 * Resolves - never hangs, never rejects. A timeout, a spawn failure and an auth
 * failure are three distinguishable outcomes in the returned payload.
 */
export async function checkAgentHealth(backend: string): Promise<AgentHealthResult> {
  const startTime = Date.now();
  const deadline = startTime + HEALTH_CHECK_BUDGET_MS;

  // Detection may still be running when the health pill mounts; without this
  // wait the check reports "CLI not found" for a CLI that is simply not
  // registered yet.
  await agentRegistry.whenReady();

  const agents = agentRegistry.getDetectedAgents();
  const agent = agents.find((a) => isAgentKind(a, 'acp') && a.backend === backend);
  const acpAgent = agent && isAgentKind(agent, 'acp') ? agent : undefined;

  // Skip CLI check for claude/codebuddy (uses npx) and codex (has its own detection)
  if (!acpAgent?.cliPath && backend !== 'claude' && backend !== 'codebuddy' && backend !== 'codex') {
    return {
      success: false,
      msg: `${backend} CLI not found`,
      data: { available: false, error: 'CLI not installed' },
    };
  }

  const tempDir = os.tmpdir();
  const factory = new LegacyConnectorFactory();
  const client = factory.create(
    {
      agentBackend: backend,
      agentSource: 'builtin',
      agentId: `health-check-${backend}`,
      cwd: tempDir,
      command: acpAgent?.cliPath,
      args: acpAgent?.acpArgs,
    },
    noopProtocolHandlers
  );

  try {
    await withDeadline(client.start(), 'start', deadline);
    const session = await withDeadline(client.createSession({ cwd: tempDir }), 'session', deadline);
    await withDeadline(client.prompt(session.sessionId, [{ type: 'text', text: 'hi' }]), 'prompt', deadline);

    const latency = Date.now() - startTime;
    await client.close();

    return { success: true, data: { available: true, latency } };
  } catch (error) {
    // Closing terminates the subprocess, which is what unblocks a stalled
    // agent's still-pending request instead of leaving it orphaned.
    try {
      await client.close();
    } catch {
      // Ignore close errors
    }

    if (error instanceof HealthCheckTimeoutError) {
      const message = `${backend} health check ${error.message}`;
      return {
        success: false,
        msg: message,
        data: { available: false, error: message, latency: Date.now() - startTime },
      };
    }

    const errorMsg = error instanceof Error ? error.message : String(error);

    if (isAuthError(errorMsg)) {
      return {
        success: false,
        msg: `${backend} not authenticated`,
        data: { available: false, error: 'Not authenticated' },
      };
    }

    return {
      success: false,
      msg: `${backend} health check failed: ${errorMsg}`,
      data: { available: false, error: errorMsg },
    };
  }
}
