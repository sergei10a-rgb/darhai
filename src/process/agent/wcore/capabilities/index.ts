/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Capability registry and dispatcher.
 *
 * The decoder's default arm dispatches through the {@link CapabilitySet} its
 * own agent owns, before it decides an event is unhandled. Registration is a
 * single list so the set of capabilities is readable in one place; each entry
 * lives in its own module so they can be built and reviewed independently.
 *
 * A SET rather than a global, because Darhai runs one engine per open
 * conversation and some capabilities keep per-engine state - see
 * {@link createCapabilitySet}.
 *
 * See `./types.ts` for the invariants this file enforces.
 */

import type { CapabilityContext, CapabilityHandler } from './types';
import { anvilReceiptsCapability } from './handlers/anvilReceipts';
import { budgetGrantsCapability } from './handlers/budgetGrants';
import { capabilityActivationCapability } from './handlers/capabilityActivation';
import { durableGoalsCapability } from './handlers/durableGoals';
import { createExecutionPolicyCapability } from './handlers/executionPolicy';
import type { ExecutionPolicyCapability } from './handlers/executionPolicy';
import { hostDelegatedDeliveryCapability } from './handlers/hostDelegatedDelivery';
import { runtimeDiagnosticsCapability } from './handlers/runtimeDiagnostics';
import { turnRecoveryCapability } from './handlers/turnRecovery';
import { workflowLifecycleCapability } from './handlers/workflowLifecycle';

/**
 * One agent's capabilities: the handler list, a dispatcher bound to it, and the
 * handles an agent has to reach a capability by name.
 *
 * WHY A SET AND NOT A GLOBAL. Darhai runs several engines at once -
 * `WorkerTaskManager.taskList` holds one `WCoreManager`, hence one
 * `WCoreAgent`, hence one engine child, per open conversation. A capability
 * that keeps per-ENGINE state therefore cannot be a process-wide object, and
 * execution policy is the proof: its revision tracker is reset on every `ready`
 * (a `ready` means a new engine), so one conversation starting rewound the
 * tracker another conversation was still advancing. That conversation's next
 * legal receipt then read as a forward gap, which by the tracker's own rule it
 * can never recover from - the badge showed a foreign posture, permanently
 * stale, warning about an update that had in fact arrived.
 */
export type CapabilitySet = {
  /** Every handler in this set, in registration order. */
  readonly handlers: readonly CapabilityHandler[];
  /** Dispatcher over exactly {@link handlers}. */
  readonly dispatch: (event: Record<string, unknown>, ctx: CapabilityContext) => boolean;
  /** This set's execution-policy capability. Never shared with another set. */
  readonly executionPolicy: ExecutionPolicyCapability;
};

/**
 * Build one agent's capability set.
 *
 * Adding a capability is: write the module, import it, add it to the list
 * below. The overlap check runs on every build, so a duplicated event type is a
 * failure the first time an agent starts - not a silent case of "whichever
 * registered first wins".
 *
 * Membership is what makes a capability real. Until a module appears here,
 * dispatch returns false for its events and they fall through to the
 * acknowledged-inert check - the module is correct, tested, and does nothing.
 * Every wave-1 review found exactly that and was right to.
 *
 * WHICH ENTRIES ARE PER-SET AND WHICH ARE SHARED. Only capabilities built here
 * by a factory are per-set. The rest are module singletons, and that is a
 * deliberate, narrower statement than "they are stateless": `capabilityActivation`
 * and `runtimeDiagnostics` are read back through module-level accessors
 * (`readCapabilityActivationSnapshot`, the diagnostics request ledger) that the
 * Settings IPC calls without an agent in hand, so making them per-set would
 * disconnect the readout from the live engine. They are reset on `ready` for
 * the same reason execution policy was, and carry the same cross-conversation
 * hazard; that is recorded against those surfaces rather than papered over
 * here.
 */
export function createCapabilitySet(): CapabilitySet {
  const executionPolicy = createExecutionPolicyCapability();
  const handlers: readonly CapabilityHandler[] = [
    // Wave 1 - independent subsystems
    executionPolicy,
    workflowLifecycleCapability,
    anvilReceiptsCapability,
    budgetGrantsCapability,
    // Wave 2 - gated on the negotiated contract
    turnRecoveryCapability,
    durableGoalsCapability,
    runtimeDiagnosticsCapability,
    capabilityActivationCapability,
    // Wave 3 - the engine waits on this one
    hostDelegatedDeliveryCapability,
  ];
  return { handlers, dispatch: createDispatcher(handlers), executionPolicy };
}

/**
 * A set nobody dispatches a live engine through.
 *
 * It exists so the questions that are about the REGISTRY rather than about one
 * engine - which event types are claimed, which frame types survive the msg_id
 * guard, is there an overlap - have a stable answer without booting an agent.
 * Those answers are identical for every set, because every set is built from
 * the same list.
 */
const REGISTRY: CapabilitySet = createCapabilitySet();

const HANDLERS: readonly CapabilityHandler[] = REGISTRY.handlers;

/**
 * Two capabilities claiming the same event type is a design error, not a
 * runtime condition to recover from: dispatch order would decide behaviour,
 * and that order is an accident of import sequence.
 *
 * Exported so tests exercise this exact function rather than a copy of its
 * rules - a copy would keep passing after the real one changed.
 */
export function assertNoOverlap(handlers: readonly CapabilityHandler[]): void {
  const owner = new Map<string, string>();
  for (const handler of handlers) {
    if (handler.handles.length === 0) {
      throw new Error(`capability "${handler.name}" declares no event types`);
    }
    for (const type of handler.handles) {
      const existing = owner.get(type);
      if (existing) {
        throw new Error(`capabilities "${existing}" and "${handler.name}" both claim event "${type}"`);
      }
      owner.set(type, handler.name);
    }
  }
}

/**
 * Build a dispatcher over a specific handler set.
 *
 * Production passes {@link HANDLERS}; tests pass a handful. Both go through
 * this function, so what a test proves about isolation or routing is true of
 * the real dispatcher and not of a stand-in.
 *
 * The returned dispatcher answers `true` when a capability consumed the event,
 * `false` when no capability claims the type OR the owning handler declined it.
 * The caller treats `false` as "not handled here".
 *
 * A handler that throws is contained: the error is logged against the
 * capability and the event is reported as unhandled. Losing a diagnostics
 * readout is an acceptable outcome; losing the turn it arrived during is not.
 */
export function createDispatcher(
  handlers: readonly CapabilityHandler[]
): (event: Record<string, unknown>, ctx: CapabilityContext) => boolean {
  assertNoOverlap(handlers);
  const byType = new Map<string, CapabilityHandler>(handlers.flatMap((h) => h.handles.map((t) => [t, h] as const)));

  return (event, ctx) => {
    const type = typeof event.type === 'string' ? event.type : '';
    if (!type) return false;
    const handler = byType.get(type);
    if (!handler) return false;

    const scoped: CapabilityContext = {
      ...ctx,
      log: (message, detail) => ctx.log(`[${handler.name}] ${message}`, detail),
      warn: (message, detail) => ctx.warn(`[${handler.name}] ${message}`, detail),
    };

    try {
      return handler.handle(event, scoped);
    } catch (cause) {
      ctx.warn(`[${handler.name}] handler threw on "${type}"`, cause);
      return false;
    }
  };
}

/**
 * The registry's dispatcher. Answers routing questions - "does anything claim
 * this type?" - without an agent.
 *
 * NOT for a live engine. It is bound to {@link REGISTRY}, which every agent
 * shares, so routing a real session's `execution_policy` through it would put
 * that session's revisions into a tracker other sessions also write to - the
 * exact defect {@link CapabilitySet} exists to remove. `WCoreAgent` builds its
 * own set; `wcore-readySeed.test.ts` fails if it stops doing so.
 */
export const dispatchCapabilityEvent = createDispatcher(HANDLERS);

/** Event types currently claimed by a capability. Exported for tests. */
export function claimedEventTypes(): readonly string[] {
  return HANDLERS.flatMap((h) => [...h.handles]).sort();
}

/**
 * Every frame type a capability can put on the renderer stream.
 *
 * Consumed types are included because most capabilities emit under a name they
 * also handle; `emits` adds the projections that differ. `WCoreManager` uses
 * this to decide what survives its msg_id guard - keying that on `handles`
 * alone silently dropped `workflow_run` and `anvil_receipt_alert`.
 */
export function forwardableFrameTypes(): readonly string[] {
  return [...new Set(HANDLERS.flatMap((h) => [...h.handles, ...(h.emits ?? [])]))].sort();
}

/** The registered capabilities. Exported for tests and diagnostics. */
export function registeredCapabilities(): readonly CapabilityHandler[] {
  return HANDLERS;
}

export type { CapabilityContext, CapabilityHandler } from './types';
