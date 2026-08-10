/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Capability registry and dispatcher.
 *
 * The decoder's default arm calls {@link dispatchCapabilityEvent} before it
 * decides an event is unhandled. Registration is a single list so the set of
 * capabilities is readable in one place; each entry lives in its own module so
 * they can be built and reviewed independently.
 *
 * See `./types.ts` for the invariants this file enforces.
 */

import type { CapabilityContext, CapabilityHandler } from './types';
import { anvilReceiptsCapability } from './handlers/anvilReceipts';
import { budgetGrantsCapability } from './handlers/budgetGrants';
import { capabilityActivationCapability } from './handlers/capabilityActivation';
import { durableGoalsCapability } from './handlers/durableGoals';
import { executionPolicyCapability } from './handlers/executionPolicy';
import { runtimeDiagnosticsCapability } from './handlers/runtimeDiagnostics';
import { turnRecoveryCapability } from './handlers/turnRecovery';
import { workflowLifecycleCapability } from './handlers/workflowLifecycle';

/**
 * Every capability module Darhai has wired up.
 *
 * Adding one is: write the module, import it, add it here. The overlap check
 * runs at module load, so a duplicated event type is a startup failure in dev
 * and in tests - not a silent case of "whichever registered first wins".
 *
 * Registration is what makes a capability real. Until a module appears here,
 * `dispatchCapabilityEvent` returns false for its events and they fall through
 * to the acknowledged-inert check - the module is correct, tested, and does
 * nothing. Every wave-1 review found exactly that and was right to.
 */
const HANDLERS: readonly CapabilityHandler[] = [
  // Wave 1 - independent subsystems
  executionPolicyCapability,
  workflowLifecycleCapability,
  anvilReceiptsCapability,
  budgetGrantsCapability,
  // Wave 2 - gated on the negotiated contract
  turnRecoveryCapability,
  durableGoalsCapability,
  runtimeDiagnosticsCapability,
  capabilityActivationCapability,
];

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

/** The production dispatcher. Overlap is checked at module load. */
export const dispatchCapabilityEvent = createDispatcher(HANDLERS);

/** Event types currently claimed by a capability. Exported for tests. */
export function claimedEventTypes(): readonly string[] {
  return HANDLERS.flatMap((h) => [...h.handles]).sort();
}

/** The registered capabilities. Exported for tests and diagnostics. */
export function registeredCapabilities(): readonly CapabilityHandler[] {
  return HANDLERS;
}

export type { CapabilityContext, CapabilityHandler } from './types';
