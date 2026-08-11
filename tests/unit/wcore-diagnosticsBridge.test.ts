/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The caller `runtimeDiagnostics.ts` says it needs and never had.
 *
 * That module's own header names three things outside it that must exist
 * before any of its 2000 lines is reachable, and the third was missing:
 * "A CALLER. Nothing in this module can originate a round-trip." Without one,
 * `get_runtime_diagnostics` and `remove_mcp_server` were never written to any
 * engine, so `runtime_diagnostics_snapshot` / `_unavailable` /
 * `mcp_removal_result` could never arrive and the entire Runtime → Diagnostics
 * section plus the MCP withdrawal notice were unreachable markup.
 *
 * These tests drive the REAL send path over fake tasks and assert on the bytes
 * that reach the engine's stdin, then feed the contract's own reply back through
 * the REAL handler. A hand-shaped command object would keep passing after the
 * builder changed; a schema-validated one cannot.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  __testables,
  WCORE_AGENT_CHILD_FIELD,
  WCORE_MANAGER_AGENT_FIELD,
} from '@process/bridge/wcoreDiagnosticsBridge';
import { NO_CONTRACT, negotiateContract } from '@process/agent/wcore/capabilities/contractNegotiation';
import {
  pendingRuntimeRequestIds,
  resetRuntimeRequests,
  runtimeDiagnosticsCapability,
} from '@process/agent/wcore/capabilities/handlers/runtimeDiagnostics';
import { createDispatcher } from '@process/agent/wcore/capabilities';
import type { CapabilityContext, CapabilityStreamFrame } from '@process/agent/wcore/capabilities/types';
import type { IAgentManager } from '@process/task/IAgentManager';
import type { IWorkerTaskManager } from '@process/task/IWorkerTaskManager';
import { examplePayload, validateCommand } from '../helpers/engineContract';

const { engineOf, liveEngines, requestRuntimeDiagnostics, withdrawMcpServer, engineLiveness } = __testables;

/** A stand-in for one `WCoreManager` holding one live engine. */
type FakeTask = {
  type: string;
  lastActivityAt: number;
  written: Array<Record<string, unknown>>;
  [WCORE_MANAGER_AGENT_FIELD]: unknown;
};

function fakeTask(options: {
  type?: string;
  alive?: boolean;
  /**
   * Whether the child's stdin still accepts writes. Defaults to true, and it is
   * a SEPARATE knob from `alive` on purpose: `WCoreAgent.isAlive` is
   * `childProcess !== null` while its writer requires
   * `childProcess.stdin.writable`, so an agent can answer alive and still drop
   * every command. A fake without the child would be a fake that cannot express
   * the gap this bridge has to close.
   */
  writable?: boolean;
  lastActivityAt?: number;
  contract?: unknown;
  agent?: unknown;
}): FakeTask {
  const written: Array<Record<string, unknown>> = [];
  const agent =
    'agent' in options
      ? options.agent
      : {
          contract: options.contract ?? negotiateContract(examplePayload('event', 'ready')),
          isAlive: options.alive !== false,
          [WCORE_AGENT_CHILD_FIELD]: { stdin: { writable: options.writable !== false } },
          sendCommand: (command: Record<string, unknown>) => written.push(command),
        };
  return {
    type: options.type ?? 'wcore',
    lastActivityAt: options.lastActivityAt ?? 0,
    written,
    agent,
  } as FakeTask;
}

function fakeManager(tasks: Record<string, FakeTask>): IWorkerTaskManager {
  return {
    getTask: (id: string) => tasks[id] as unknown as IAgentManager,
    getOrBuildTask: () => Promise.reject(new Error('not used')),
    addTask: (): void => undefined,
    kill: (): void => undefined,
    clear: () => Promise.resolve(),
    listTasks: () => Object.entries(tasks).map(([id, task]) => ({ id, type: task.type as never })),
  } as unknown as IWorkerTaskManager;
}

/** A context that records what the handler emitted, for the reply half. */
function recorder(): CapabilityContext & { frames: CapabilityStreamFrame[] } {
  const frames: CapabilityStreamFrame[] = [];
  return {
    frames,
    sendCommand: () => undefined,
    emit: (frame) => frames.push(frame),
    activeMsgId: () => '',
    log: () => undefined,
    warn: () => undefined,
  };
}

beforeEach(() => resetRuntimeRequests());
afterEach(() => resetRuntimeRequests());

describe('reaching the live engine', () => {
  it('finds the engine a Darhai Core conversation is running', () => {
    const task = fakeTask({});
    expect(engineOf(task as unknown as IAgentManager)).not.toBeNull();
  });

  it('reports no engine for a conversation of another kind', () => {
    expect(engineOf(fakeTask({ type: 'acp' }) as unknown as IAgentManager)).toBeNull();
  });

  it('reports no engine once the child process is gone', () => {
    expect(engineOf(fakeTask({ alive: false }) as unknown as IAgentManager)).toBeNull();
  });

  it('reports no engine rather than throwing when the manager holds nothing there', () => {
    // The field is read structurally, so a rename must degrade to "nothing to
    // ask" - never to a crash inside an IPC provider.
    expect(engineOf(fakeTask({ agent: null }) as unknown as IAgentManager)).toBeNull();
    expect(engineOf(fakeTask({ agent: { isAlive: true } }) as unknown as IAgentManager)).toBeNull();
    expect(engineOf(undefined)).toBeNull();
  });

  it('orders engines most recently active first', () => {
    const manager = fakeManager({
      old: fakeTask({ lastActivityAt: 10 }),
      newest: fakeTask({ lastActivityAt: 30 }),
      middle: fakeTask({ lastActivityAt: 20 }),
    });
    expect(liveEngines(manager).map((t) => t.conversationId)).toEqual(['newest', 'middle', 'old']);
  });
});

describe('asking for a runtime diagnostics snapshot', () => {
  it('writes a schema-valid get_runtime_diagnostics to the most recent engine only', () => {
    const stale = fakeTask({ lastActivityAt: 1 });
    const fresh = fakeTask({ lastActivityAt: 2 });
    const outcome = requestRuntimeDiagnostics(fakeManager({ stale, fresh }));

    expect(outcome.engines).toBe(2);
    expect(outcome.refused).toEqual([]);
    expect(outcome.sent).toHaveLength(1);
    expect(outcome.sent[0].conversationId).toBe('fresh');
    expect(typeof outcome.sent[0].requestId).toBe('string');

    // A snapshot describes ONE process; two would race into one readout.
    expect(stale.written).toHaveLength(0);
    expect(fresh.written).toHaveLength(1);
    const command = fresh.written[0];
    expect(command.type).toBe('get_runtime_diagnostics');
    expect(command.request_id).toBe(outcome.sent[0].requestId);
    const check = validateCommand(command);
    expect(check.errors.join('\n')).toBe('');
    expect(check.valid).toBe(true);
  });

  it('says no engine rather than pretending it asked one', () => {
    const outcome = requestRuntimeDiagnostics(fakeManager({ chat: fakeTask({ alive: false }) }));
    expect(outcome).toEqual({ engines: 0, sent: [], refused: [] });
  });

  it('reports the engine’s own refusal when the contract does not grade the verb available', () => {
    // NO_CONTRACT-shaped: an engine that published a `ready` with no capability
    // grades at all. `sendRequest` must refuse rather than write a command that
    // would never be answered.
    const task = fakeTask({ contract: negotiateContract({ version: '0.0.0', contract: { capabilities: {} } }) });
    const outcome = requestRuntimeDiagnostics(fakeManager({ chat: task }));

    expect(outcome.sent).toEqual([]);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0].conversationId).toBe('chat');
    expect(outcome.refused[0].reason).toContain('runtime_diagnostics_v1');
    expect(task.written).toHaveLength(0);
    expect(pendingRuntimeRequestIds()).toEqual([]);
  });

  /**
   * The reported-sent-but-never-written gap.
   *
   * `isAlive` is `childProcess !== null`; the writer refuses unless
   * `childProcess.stdin.writable`. A request that falls between them is
   * recorded as sent, so the pane says "Asked the engine. Waiting for its
   * answer…" about bytes that never left - with no timeout (by design) and no
   * control to escape it. Restore `canReachEngine: () => engine.isAlive` and
   * this goes red.
   */
  it('refuses when the engine is alive but its stdin can no longer be written', () => {
    const task = fakeTask({ writable: false });
    const outcome = requestRuntimeDiagnostics(fakeManager({ chat: task }));

    expect(outcome.engines).toBe(1);
    expect(outcome.sent).toEqual([]);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0].reason).toContain('cannot be reached');
    expect(task.written).toHaveLength(0);
    // Nothing may be owed: a ledger entry for an unwritten command is a
    // correlation id no engine can ever answer.
    expect(pendingRuntimeRequestIds()).toEqual([]);
  });

  /**
   * The spawn window.
   *
   * `liveEngines` admits a task the moment the child exists, but the agent's
   * contract is `NO_CONTRACT` until its own `ready` lands. Gating on the grades
   * there accuses an engine that fully supports diagnostics of having refused
   * them - which is exactly what a user sees who opens a chat and clicks
   * straight into Settings. Delete the `hasSpoken` check and this goes red.
   */
  it('says the engine is still starting instead of quoting a grade it never gave', () => {
    const task = fakeTask({ contract: NO_CONTRACT });
    const outcome = requestRuntimeDiagnostics(fakeManager({ chat: task }));

    expect(outcome.sent).toEqual([]);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0].reason).toContain('still starting');
    // The accusation this replaces. `unavailable` is the engine's own word for
    // a capability it does not have, and it never said it here.
    expect(outcome.refused[0].reason).not.toContain('unavailable');
    expect(task.written).toHaveLength(0);
  });

  it('records the request so the engine’s reply settles it', () => {
    const task = fakeTask({});
    const outcome = requestRuntimeDiagnostics(fakeManager({ chat: task }));
    const requestId = outcome.sent[0].requestId as string;
    expect(pendingRuntimeRequestIds()).toEqual([requestId]);

    // The contract's own snapshot event, re-addressed to the id this bridge
    // actually minted, through the real handler.
    const reply = JSON.parse(JSON.stringify(examplePayload('event', 'runtime_diagnostics_snapshot')));
    reply.request_id = requestId;
    const ctx = recorder();
    expect(createDispatcher([runtimeDiagnosticsCapability])(reply, ctx)).toBe(true);

    const frame = ctx.frames.at(-1);
    expect(frame, 'the handler emitted nothing for a matched request').toBeDefined();
    expect(frame!.type).toBe('runtime_diagnostics_snapshot');
    const settled = frame!.data as { status: string; requestId: string };
    expect(settled.status).toBe('snapshot');
    expect(settled.requestId).toBe(requestId);
    expect(pendingRuntimeRequestIds()).toEqual([]);
  });
});

describe('withdrawing an MCP server from live sessions', () => {
  it('asks EVERY live engine, because each holds its own copy of the tools', () => {
    const a = fakeTask({ lastActivityAt: 2 });
    const b = fakeTask({ lastActivityAt: 1 });
    const outcome = withdrawMcpServer(fakeManager({ a, b }), 'desktop-tools');

    expect(outcome.engines).toBe(2);
    expect(outcome.sent.map((e) => e.conversationId).toSorted()).toEqual(['a', 'b']);
    for (const task of [a, b]) {
      expect(task.written).toHaveLength(1);
      expect(task.written[0].type).toBe('remove_mcp_server');
      expect(task.written[0].name).toBe('desktop-tools');
      const check = validateCommand(task.written[0]);
      expect(check.errors.join('\n')).toBe('');
      expect(check.valid).toBe(true);
    }
    // Two engines, two distinct correlation ids - one id answered twice cannot
    // be told apart.
    expect(new Set(outcome.sent.map((e) => e.requestId)).size).toBe(2);
  });

  it('refuses an empty name once instead of once per engine', () => {
    const task = fakeTask({});
    const outcome = withdrawMcpServer(fakeManager({ chat: task }), '');
    expect(outcome.sent).toEqual([]);
    expect(outcome.refused).toHaveLength(1);
    expect(task.written).toHaveLength(0);
  });

  /**
   * Per-engine, not per-request: one chat that cannot take the command must not
   * make the page claim the others did, nor be listed under "waiting for its
   * answer" forever. Both refusal reasons are the ones the user reads.
   */
  it('refuses only the engines that cannot take it, and says which fault it was', () => {
    const starting = fakeTask({ contract: NO_CONTRACT, lastActivityAt: 3 });
    const closed = fakeTask({ writable: false, lastActivityAt: 2 });
    const healthy = fakeTask({ lastActivityAt: 1 });
    const outcome = withdrawMcpServer(fakeManager({ starting, closed, healthy }), 'desktop-tools');

    expect(outcome.engines).toBe(3);
    expect(outcome.sent.map((e) => e.conversationId)).toEqual(['healthy']);
    expect(healthy.written).toHaveLength(1);
    expect(starting.written).toHaveLength(0);
    expect(closed.written).toHaveLength(0);

    const reasons = new Map(outcome.refused.map((e) => [e.conversationId, e.reason ?? '']));
    expect(reasons.get('starting')).toContain('still starting');
    expect(reasons.get('closed')).toContain('cannot be reached');
  });
});

/**
 * The passive liveness read behind the Settings header and the Overview
 * "Engine" card.
 *
 * Those two used to key off `acpConversation.getAvailableAgents`, whose wcore
 * entry is built `available: true` unconditionally and carries no version - so
 * the chip rendered "engine running · <pinned constant>" with no engine
 * process in existence, and the stopped branch could not fire at all. This
 * channel answers from the same `liveEngines` the diagnostics round-trip uses,
 * which is what makes the Overview agree with the Runtime pane beside it.
 */
describe('reporting engine liveness without asking the engine anything', () => {
  it('counts the live engines and reports the version the newest one published', () => {
    const liveness = engineLiveness(
      fakeManager({ a: fakeTask({ lastActivityAt: 1 }), b: fakeTask({ lastActivityAt: 2 }) })
    );
    expect(liveness.engines).toBe(2);
    // From the contract fixture's own `ready`, never from a constant in the UI.
    expect(liveness.engineVersion).toBe(negotiateContract(examplePayload('event', 'ready')).engineVersion);
    expect(liveness.engineVersion.length).toBeGreaterThan(0);
  });

  it('reports no engine and no version rather than a build number nobody read', () => {
    expect(engineLiveness(fakeManager({ dead: fakeTask({ alive: false }) }))).toEqual({
      engines: 0,
      engineVersion: '',
    });
  });

  it('reports an engine that has not published its ready with an empty version', () => {
    // Running, but it has said nothing yet: the card must fall back to the
    // pinned build and SAY that it is pinned, not present it as a reading.
    const liveness = engineLiveness(fakeManager({ starting: fakeTask({ contract: NO_CONTRACT }) }));
    expect(liveness).toEqual({ engines: 1, engineVersion: '' });
  });

  it('writes nothing to any engine - it is a status read, not a round-trip', () => {
    const task = fakeTask({});
    engineLiveness(fakeManager({ chat: task }));
    expect(task.written).toEqual([]);
    expect(pendingRuntimeRequestIds()).toEqual([]);
  });
});

/**
 * THE RENAME GUARD.
 *
 * `WCoreManager` keeps its engine in a `private` field and publishes no
 * accessor, so this bridge reads it structurally. TypeScript `private` is a
 * compile-time annotation, so a rename would not fail the build - it would make
 * every readout say "no engine is running", which is exactly the silent-empty
 * failure this whole change exists to remove. These assertions turn that into a
 * failing test with a name that says what to do.
 */
describe('the field and members this bridge reads', () => {
  const MANAGER_SRC = readFileSync(join(process.cwd(), 'src/process/task/WCoreManager.ts'), 'utf-8');
  const AGENT_SRC = readFileSync(join(process.cwd(), 'src/process/agent/wcore/index.ts'), 'utf-8');

  it('WCoreManager still holds the engine in the field this bridge reads', () => {
    expect(MANAGER_SRC).toContain(`private ${WCORE_MANAGER_AGENT_FIELD}: WCoreAgent | null`);
  });

  it('WCoreAgent still exposes contract, isAlive and sendCommand', () => {
    expect(AGENT_SRC).toContain('public contract: NegotiatedContract');
    expect(AGENT_SRC).toContain('get isAlive(): boolean');
    expect(AGENT_SRC).toContain('sendCommand(cmd: WCoreCommand): void');
  });

  it('WCoreAgent still holds the child in the field this bridge probes', () => {
    // `isAlive` is not a transport probe, so the bridge reads the same field the
    // writer does. A rename degrades to "refused", not to a false "sent" - but
    // it would refuse EVERY request, so the name is pinned here.
    expect(AGENT_SRC).toContain(`private ${WCORE_AGENT_CHILD_FIELD}: ChildProcess | null`);
    expect(AGENT_SRC).toContain(`if (!this.${WCORE_AGENT_CHILD_FIELD}?.stdin?.writable) return;`);
  });

  it('WCoreAgent still starts on NO_CONTRACT, which is how "not ready yet" is told from "unavailable"', () => {
    expect(AGENT_SRC).toContain('public contract: NegotiatedContract = NO_CONTRACT');
  });
});
