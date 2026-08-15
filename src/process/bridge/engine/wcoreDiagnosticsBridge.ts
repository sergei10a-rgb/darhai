/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the two engine round-trips a Settings surface can ORIGINATE
 * (`ipcBridge.wcoreEngine.requestRuntimeDiagnostics` / `.withdrawMcpServer`).
 *
 * WHY THIS EXISTS. `runtimeDiagnostics.ts` decodes, correlates and emits, and
 * its own header names the one thing it cannot supply: "A CALLER. Nothing in
 * this module can originate a round-trip - a handler only runs when an event
 * arrives." Until this file existed there was no caller, so
 * `runtime_diagnostics_snapshot`, `runtime_diagnostics_unavailable` and
 * `mcp_removal_result` could never arrive and ~400 lines of Runtime pane plus
 * the MCP-withdrawal notice were unreachable markup.
 *
 * WHAT IT DOES NOT DO. It does not wait for the answer. `CapabilityHandler` is
 * synchronous by design and the reply comes back minutes-of-engine-work later
 * on `conversation.responseStream`; so these providers return WHAT WAS SENT -
 * a conversation id and the correlation id its reply will carry - and the pane
 * matches the frame to its own request. A promise that resolved with the
 * snapshot would need a timeout this layer cannot honour honestly.
 *
 * IT ALSO ANSWERS ONE PASSIVE QUESTION. `ipcBridge.wcoreEngine.liveness` counts
 * the live engines and reports the version the newest one published. It writes
 * nothing to any engine, which is what makes it legal for a status card to call
 * it on mount - and it lives here because this is where `liveEngines` is, so
 * the Overview card and the Runtime pane answer from one source instead of
 * contradicting each other.
 *
 * SECURITY - HUMAN/RENDERER ONLY. All three channels are remote-denied in
 * `bridgeAllowlist.ts`, and `tests/unit/bridgeAllowlistWcoreEngine.redteam
 * .test.ts` fails if a `wcoreEngine.*` channel is ever added without a deny
 * line. The snapshot discloses the operator's config paths, ignored environment
 * overrides and which MCP servers failed to launch; withdrawal MUTATES a
 * running session by taking tools out of a live chat; liveness reports whether
 * the local user has a chat open at all.
 */

import { ipcBridge } from '@/common';
import type {
  IWcoreEngineLiveness,
  IWcoreEngineRequest,
  IWcoreRuntimeRequestOutcome,
} from '@/common/adapter/ipcBridge';
import { NO_CONTRACT } from '@process/agent/wcore/capabilities/contractNegotiation';
import type { NegotiatedContract } from '@process/agent/wcore/capabilities/contractNegotiation';
import type { CapabilityContext } from '@process/agent/wcore/capabilities/types';
import {
  mintDiagnosticsRequestId,
  mintMcpRemovalRequestId,
  sendGetRuntimeDiagnostics,
  sendRemoveMcpServer,
} from '@process/agent/wcore/capabilities/handlers/runtimeDiagnostics';
import type { SendRuntimeRequestOutcome } from '@process/agent/wcore/capabilities/handlers/runtimeDiagnostics';
import type { IAgentManager } from '@process/task/IAgentManager';
import type { IWorkerTaskManager } from '@process/task/IWorkerTaskManager';

/**
 * The part of a live `WCoreAgent` this bridge acts through.
 *
 * `WCoreManager` holds its agent in a `private` field and publishes no
 * accessor, and this change does not own that file - so the field is read
 * through a structural view. TypeScript `private` is a compile-time annotation
 * rather than a runtime barrier, so the real risk is not access, it is a
 * RENAME: the field could move and every call here would silently become "no
 * engine is running". Two things answer that. {@link engineOf} validates the
 * shape it found and treats anything unexpected exactly like a dead engine
 * (nothing sent, caller told so) instead of throwing mid-IPC; and
 * `tests/unit/wcore-diagnosticsBridge.test.ts` pins the field name and the
 * three members against the real classes, so a rename fails a named test
 * instead of silently emptying a readout.
 */
type LiveEngine = {
  readonly contract: NegotiatedContract;
  readonly isAlive: boolean;
  sendCommand: CapabilityContext['sendCommand'];
};

/** One conversation and the engine process currently serving it. */
type EngineTarget = { conversationId: string; engine: LiveEngine };

/** The field on `WCoreManager` that holds the engine. Pinned by the seam test. */
export const WCORE_MANAGER_AGENT_FIELD = 'agent';

/** The field on `WCoreAgent` that holds the spawned child. Pinned by the seam test. */
export const WCORE_AGENT_CHILD_FIELD = 'childProcess';

/**
 * Would a command written right now actually LEAVE this process?
 *
 * NOT the same question as `isAlive`, which is `childProcess !== null`, while
 * the writer opens with `if (!this.childProcess?.stdin?.writable) return;` and
 * drops the command in silence. Everything between those two conditions - a
 * child that exited but has not been reaped, a stdin that took an EPIPE - is a
 * request the ledger records as sent and no engine will ever answer. The pane
 * then sits on "Asked the engine. Waiting for its answer…" with no timeout to
 * end it (deliberately: see `useRuntimeDiagnostics`), so the only escape is
 * remounting the pane, which no copy suggests.
 *
 * So the transport is probed exactly the way the writer probes it, through the
 * same structural view {@link engineOf} already uses. Unreadable degrades to
 * false: refusing a request the user can simply repeat is the safe direction,
 * and `wcore-diagnosticsBridge.test.ts` pins the field name so a rename fails a
 * named test instead of quietly refusing every request forever.
 */
function canWriteTo(engine: LiveEngine): boolean {
  if (engine.isAlive !== true) return false;
  const child = (engine as unknown as Record<string, unknown>)[WCORE_AGENT_CHILD_FIELD];
  if (typeof child !== 'object' || child === null) return false;
  const stdin = (child as { stdin?: unknown }).stdin;
  if (typeof stdin !== 'object' || stdin === null) return false;
  return (stdin as { writable?: unknown }).writable === true;
}

/** What the caller is told when the engine has not finished starting. */
const STILL_STARTING =
  'the engine is still starting and has not yet said which capabilities it supports, so nothing was sent';

/**
 * Has THIS engine published its `ready` yet?
 *
 * `liveEngines` admits a task the moment the child exists, but `WCoreAgent
 * .contract` stays `NO_CONTRACT` - an empty grade map - until that engine's own
 * `ready` arrives. Gating on the grades inside that window makes the host report
 * `the engine graded runtime_diagnostics_v1 "unavailable"` about a capability
 * the engine fully supports: open a Core chat, click into Settings, press Ask.
 *
 * That is precisely the conflation `IWcoreCapabilitySnapshot.contractKnown`
 * exists to prevent - "an empty map means 'nothing is available' to a gate, but
 * 'we have not asked yet' to a readout" - and this bridge was the one place
 * that ignored it.
 *
 * Identity against `NO_CONTRACT` is the exact test (`WCoreAgent` holds that very
 * object until `negotiateContract` replaces it, pinned by the seam test); the
 * shape check behind it catches a contract that was replaced by an equally
 * empty one, and leaves an engine that DID publish grades - even a `ready` that
 * graded everything unavailable - to the real contract gate.
 */
function hasSpoken(engine: LiveEngine): boolean {
  const contract = engine.contract;
  if (contract === NO_CONTRACT) return false;
  const grades = contract.grades as { size?: unknown } | undefined;
  const graded = typeof grades?.size === 'number' && grades.size > 0;
  return graded || contract.engineVersion !== '';
}

/**
 * The live engine behind one task, or null.
 *
 * Null covers every reason a command would be pointless: not a Darhai Core
 * conversation, bootstrap never finished, the child already exited, or the
 * manager no longer holds its agent where this bridge looks. All four are
 * "nothing to ask", which is what the caller is told.
 */
function engineOf(task: IAgentManager | undefined): LiveEngine | null {
  if (!task || task.type !== 'wcore') return null;
  const held = (task as unknown as Record<string, unknown>)[WCORE_MANAGER_AGENT_FIELD];
  if (typeof held !== 'object' || held === null) return null;
  const view = held as Partial<LiveEngine>;
  // `=== true` / `typeof` rather than truthiness: this repo compiles without
  // strictNullChecks, so an optional member narrows only on an explicit check.
  if (view.isAlive !== true) return null;
  if (typeof view.sendCommand !== 'function') return null;
  if (typeof view.contract !== 'object' || view.contract === null) return null;
  return view as LiveEngine;
}

/** Every live Darhai Core engine, most recently active first. */
function liveEngines(workerTaskManager: IWorkerTaskManager): EngineTarget[] {
  const targets: Array<EngineTarget & { at: number }> = [];
  for (const entry of workerTaskManager.listTasks()) {
    if (entry.type !== 'wcore') continue;
    const task = workerTaskManager.getTask(entry.id);
    const engine = engineOf(task);
    if (engine === null) continue;
    targets.push({ conversationId: entry.id, engine, at: task ? task.lastActivityAt : 0 });
  }
  targets.sort((a, b) => b.at - a.at);
  return targets.map(({ conversationId, engine }) => ({ conversationId, engine }));
}

/**
 * The narrow surface the send functions act through, for ONE command.
 *
 * Built per call for the same reason `WCoreAgent.capabilityContext()` is: a
 * context that outlives its command is a handle onto an engine that may already
 * be gone.
 */
function sendContext(conversationId: string, engine: LiveEngine): CapabilityContext {
  const label = `[wcoreDiagnostics ${conversationId}]`;
  return {
    sendCommand: (command) => engine.sendCommand(command),
    // Nothing on the send path emits - `sendRequest` only warns and writes, and
    // every reply frame is emitted later through the AGENT's own context, which
    // is the one wired to the renderer. A frame arriving here would therefore
    // be a frame with nowhere to go, so it is reported rather than dropped in
    // silence.
    emit: (frame) => console.warn(`${label} a send-only context was asked to emit ${frame.type} - not forwarded`),
    // Diagnostics frames are deliberately msg_id-less (see `emitDiagnosticsFrame`):
    // a Settings-initiated fact must not be filed under whatever turn is open.
    activeMsgId: () => '',
    log: (message, detail) =>
      detail === undefined ? console.log(`${label} ${message}`) : console.log(`${label} ${message}`, detail),
    warn: (message, detail) =>
      detail === undefined ? console.warn(`${label} ${message}`) : console.warn(`${label} ${message}`, detail),
  };
}

function toRequest(conversationId: string, outcome: SendRuntimeRequestOutcome): IWcoreEngineRequest {
  // `=== true`, not `outcome.ok`: without strictNullChecks only an explicit
  // comparison narrows the union, and the other arm carries `reason`.
  if (outcome.ok === true) return { conversationId, requestId: outcome.requestId };
  return { conversationId, reason: outcome.reason };
}

/** Fold one send into the outcome the renderer reads. */
function collect(
  engines: number,
  entries: Array<{ entry: IWcoreEngineRequest; ok: boolean }>
): IWcoreRuntimeRequestOutcome {
  return {
    engines,
    sent: entries.filter((e) => e.ok).map((e) => e.entry),
    refused: entries.filter((e) => !e.ok).map((e) => e.entry),
  };
}

/**
 * Ask the most recently active engine for a diagnostics snapshot.
 *
 * ONE engine, not all of them: a snapshot names config paths, ignored
 * environment variables and per-server failures that belong to ONE process, so
 * N snapshots would race into one readout with no way to tell which engine each
 * described. `engines` still reports the true count so the pane can say the
 * readout describes one of several open chats.
 */
function requestRuntimeDiagnostics(workerTaskManager: IWorkerTaskManager): IWcoreRuntimeRequestOutcome {
  const engines = liveEngines(workerTaskManager);
  const target = engines[0];
  if (target === undefined) return { engines: 0, sent: [], refused: [] };
  if (!hasSpoken(target.engine)) {
    return collect(engines.length, [
      { entry: { conversationId: target.conversationId, reason: STILL_STARTING }, ok: false },
    ]);
  }

  const outcome = sendGetRuntimeDiagnostics(
    sendContext(target.conversationId, target.engine),
    mintDiagnosticsRequestId(),
    { contract: target.engine.contract, canReachEngine: () => canWriteTo(target.engine) }
  );
  return collect(engines.length, [{ entry: toRequest(target.conversationId, outcome), ok: outcome.ok === true }]);
}

/**
 * Ask EVERY live engine to drop one MCP server.
 *
 * All of them, unlike diagnostics: each open chat has its own engine process
 * holding its own copy of the server's tools, and a user who removed a server
 * from the library did not mean "in one of my chats".
 */
function withdrawMcpServer(workerTaskManager: IWorkerTaskManager, name: unknown): IWcoreRuntimeRequestOutcome {
  const engines = liveEngines(workerTaskManager);
  // Validated at the boundary rather than left to the command builder: the
  // builder would refuse once per engine and report the same fault N times.
  if (typeof name !== 'string' || name.length === 0) {
    return {
      engines: engines.length,
      sent: [],
      refused: engines.map((t) => ({ conversationId: t.conversationId, reason: 'no server name was given' })),
    };
  }

  return collect(
    engines.length,
    engines.map((target) => {
      if (!hasSpoken(target.engine)) {
        return { entry: { conversationId: target.conversationId, reason: STILL_STARTING }, ok: false };
      }
      const outcome = sendRemoveMcpServer(
        sendContext(target.conversationId, target.engine),
        { requestId: mintMcpRemovalRequestId(), name },
        { contract: target.engine.contract, canReachEngine: () => canWriteTo(target.engine) }
      );
      return { entry: toRequest(target.conversationId, outcome), ok: outcome.ok === true };
    })
  );
}

/**
 * How many Darhai Core engines are running, and which version they report.
 *
 * A PASSIVE read, unlike the two round-trips above: it writes nothing to any
 * engine, so a status card may call it on mount. It exists because the Settings
 * header and the Overview "Engine" card had no way to ask. They keyed off
 * `acpConversation.getAvailableAgents`, whose wcore entry is built with
 * `available: true` unconditionally and carries no version - so the chip said
 * "engine running · <pinned constant>" whether or not any engine process
 * existed, and the stopped branch was unreachable. `engines` here is the same
 * count `requestRuntimeDiagnostics` reports, from the same `liveEngines`, which
 * is what makes the Overview agree with the Runtime pane beside it.
 *
 * `engineVersion` is the semver from the last `ready` (`''` when no engine has
 * published one yet), so a caller can tell a reported version from the build
 * Darhai was pinned to instead of printing the constant as if it were a
 * reading.
 */
function engineLiveness(workerTaskManager: IWorkerTaskManager): IWcoreEngineLiveness {
  const engines = liveEngines(workerTaskManager);
  // The most recently active engine's own contract, not the retained record:
  // this answers "what is running", and the retained record survives the
  // process that wrote it.
  const version = engines[0] === undefined ? '' : engines[0].engine.contract.engineVersion;
  return { engines: engines.length, engineVersion: typeof version === 'string' ? version : '' };
}

export function initWcoreDiagnosticsBridge(workerTaskManager: IWorkerTaskManager): void {
  ipcBridge.wcoreEngine.requestRuntimeDiagnostics.provider(async () => requestRuntimeDiagnostics(workerTaskManager));
  ipcBridge.wcoreEngine.withdrawMcpServer.provider(async ({ name }) => withdrawMcpServer(workerTaskManager, name));
  ipcBridge.wcoreEngine.liveness.provider(async () => engineLiveness(workerTaskManager));
}

/** Exported for the seam test, which drives the real send path over fake tasks. */
export const __testables = { engineOf, liveEngines, requestRuntimeDiagnostics, withdrawMcpServer, engineLiveness };
