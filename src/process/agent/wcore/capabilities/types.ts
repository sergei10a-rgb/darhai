/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The extension point for engine capabilities Darhai handles outside the main
 * decoder switch.
 *
 * WHY THIS EXISTS. `WCoreAgent.handleEvent` is one switch over `WCoreEvent`,
 * and `index.ts` is already 1100+ lines. The engine's v0.12.26 contract adds 34
 * verbs across nine independent subsystems (turn recovery, durable goals,
 * workflow lifecycle, execution policy, anvil receipts, runtime diagnostics,
 * budget grants, host-delegated delivery, capability activation). Folding all
 * of them into that switch would make one unreadable file, one merge conflict
 * for every change, and one blast radius.
 *
 * Instead each capability owns a module here. It declares which event types it
 * consumes and gets a narrow context to act through - it cannot reach into the
 * agent, only send a command, emit a stream frame, or log. The decoder's
 * default arm routes to whichever module claims the type.
 *
 * INVARIANTS worth keeping:
 *  - a capability handles ONLY the types it declares; two capabilities must not
 *    claim the same type (`assertNoOverlap` enforces this at registration);
 *  - a throwing handler must never take the turn down - the dispatcher isolates
 *    it, because a bug in a diagnostics readout is not worth losing a user's
 *    conversation over;
 *  - handlers are synchronous. Anything slow belongs behind a command the
 *    engine answers later, not inside the decode path.
 */

import type { WCoreCommand } from '../protocol';

/** A stream frame as `WCoreAgent` forwards it to the task layer. */
export type CapabilityStreamFrame = {
  type: string;
  data: unknown;
  msg_id: string;
};

/**
 * What a capability may do. Deliberately small: everything a handler needs and
 * nothing that would let it reach around the agent's own lifecycle.
 */
export type CapabilityContext = {
  /**
   * Send a command to the engine (e.g. answer a request the engine made).
   *
   * Accepts a capability's own command shape as well as a `WCoreCommand`. The
   * core union covers the verbs the decoder itself speaks; a capability owns
   * verbs the decoder never touches (`session_resync`, `goal_open`,
   * `continue_with_budget`, ...), and forcing all of them into that union would
   * make one shared file the merge point for nine independent modules. Each
   * capability declares its own precisely-typed command in its own module and
   * is type-safe internally; this signature is the widened seam between them.
   */
  sendCommand: (command: WCoreCommand | ({ type: string } & Record<string, unknown>)) => void;
  /** Forward a frame to the task layer / renderer. */
  emit: (frame: CapabilityStreamFrame) => void;
  /** The msg_id of the turn in flight, or '' outside a turn. */
  activeMsgId: () => string;
  /** Structured log, prefixed by the capability name. */
  log: (message: string, detail?: unknown) => void;
  /** Structured warning; use for contract violations the operator should see. */
  warn: (message: string, detail?: unknown) => void;
};

/** One engine capability, handled outside the main decoder switch. */
export type CapabilityHandler = {
  /** Contract capability id, e.g. `turn_recovery_v1`. Used in logs and tests. */
  readonly name: string;
  /**
   * Event types this handler consumes, exactly as they appear on the wire.
   * Must be non-empty and must not overlap another handler's set.
   */
  readonly handles: readonly string[];
  /**
   * Process one event. Return `true` when handled. Returning `false` lets the
   * event fall through to the acknowledged-unhandled check, which is the honest
   * answer for an event a capability recognises but chooses to ignore in the
   * current state (e.g. a snapshot for a session that is not ours).
   */
  handle(event: Record<string, unknown>, ctx: CapabilityContext): boolean;
};
