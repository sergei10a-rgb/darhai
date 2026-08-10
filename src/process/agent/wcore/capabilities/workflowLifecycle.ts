/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `workflow_lifecycle_v1` - per-run lifecycle for the engine's own .ron workflows.
 *
 * WHAT THE ENGINE SENDS. Three event types, all graded `criticality: safety` in
 * the contract manifest and all correlating on `run_id` + `sequence`:
 * `workflow_started` opens a run, `workflow_node_event` moves one node through
 * queued/running/succeeded/failed/blocked, `workflow_finished` closes the run.
 * A fourth type, `sub_agent_event`, is assigned to this capability too but
 * correlates on a DIFFERENT key (`child_run_id` + `child_sequence`) - it is the
 * node's output stream, not a run transition. Keeping the two counters apart is
 * load-bearing: `valid-lifecycle.jsonl` interleaves two child events between
 * run sequences 2 and 3, so a reducer that let children advance the run counter
 * would read the perfectly legal trailing node event as an out-of-order line.
 *
 * WHY A REDUCER AND NOT A PASS-THROUGH. The three run types are listed in
 * `ACKNOWLEDGED_UNHANDLED_EVENTS`, so today a workflow node that fails produces
 * a conversation that simply goes quiet. But forwarding them raw would be worse
 * than silence, because the stream can contradict itself. The eight adversarial
 * fixtures under `adversarial/workflow/` are exactly those contradictions - a
 * duplicate `event_id` carrying a different body, a node event arriving after
 * the run was closed, a second terminal for a node that already succeeded. A
 * card that can be flipped from succeeded to failed by a later line is a card
 * that lies, and `safety` is the grade the contract puts on that.
 *
 * WIRING REQUIRED - none of it exists yet, and this module cannot add it.
 * Everything below is a reducer over payloads someone hands it; nothing in the
 * running app hands it any. Adoption means four changes in files this module
 * does not own:
 *   1. `capabilities/index.ts` must list {@link workflowLifecycleCapability} in
 *      `HANDLERS`. That array is empty, so the dispatcher routes nothing here
 *      and the three run types never arrive.
 *   2. `protocol.ts` should drop `workflow_started` / `workflow_node_event` /
 *      `workflow_finished` from `ACKNOWLEDGED_UNHANDLED_EVENTS` once (1) lands.
 *      Dispatch runs first, so leaving them costs nothing on the happy path -
 *      but a payload this module refuses as malformed would fall through to a
 *      list that suppresses the warning, which is the opposite of the point.
 *   3. The decoder's `sub_agent_event` arm (`wcore/index.ts`) must call
 *      {@link WorkflowLifecycleCapability.observeSubAgentEvent}. Today that arm
 *      forwards every copy of every child event straight to the task layer and
 *      asks nothing, so the child correlation this module implements is not
 *      consulted by anyone.
 *   4. Something must render {@link WORKFLOW_RUN_FRAME}. No renderer surface
 *      reads a `workflow_run` frame today.
 *
 * WHAT THE CONTRACT DOES NOT SETTLE. The manifest publishes correlation keys and
 * criticality; it does not publish a verdict per fixture, and
 * `tests/helpers/engineContract.ts` says so in as many words. Every rule below
 * therefore carries its own justification, and where two readings were
 * defensible the conservative one was taken and labelled. This capability
 * declares no commands (`manifest.commands` for it is empty), so a host has no
 * way to ask the engine to resend anything - that single fact decides the
 * sequence-gap rule below.
 */

import type { CapabilityContext, CapabilityHandler } from './types';

/** Contract capability id. Used for the log/warn prefix and by the handler's `name`. */
const CAPABILITY_NAME = 'workflow_lifecycle_v1';

// ============================================
// Wire types (derived field-by-field from schema/core-event.schema.json)
// ============================================

/** Failure detail carried by a failed node or a failed run. All three fields are required when present. */
export type WorkflowFailure = { code: string; message: string; retryable: boolean };

/** The five node states in the schema enum. `blocked` appears there only - no fixture emits it. */
export type WorkflowNodeState = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';

/** A run's terminal state. `blocked` is deliberately absent: it is a node state, not a run state. */
export type WorkflowTerminalState = 'succeeded' | 'failed';

/** `workflow_started` - a .ron workflow run opened. */
export type WorkflowStartedEvent = {
  type: 'workflow_started';
  /** Stable id of the workflow definition, e.g. `desktop-audit`. */
  workflow_id: string;
  /** Human-readable display name, e.g. `Desktop audit`. */
  name: string;
  /** Declared node count. Fixtures show 0 and 1; nothing ties it to the nodes actually observed. */
  node_count: number;
  /** Correlation key for the whole run; pairs with `sequence`. */
  run_id: string;
  /** Idempotency key. Same id + same body = replay; same id + different body = conflict. */
  event_id: string;
  /** Monotonic per-run counter. Only the three workflow_* types advance it. */
  sequence: number;
  /** Present only when this run was spawned by another run. */
  parent_run_id?: string;
};

/** `workflow_node_event` - one node's state transition. */
export type WorkflowNodeEventPayload = {
  type: 'workflow_node_event';
  run_id: string;
  /** Node identifier within the workflow definition, e.g. `scan`. */
  node_id: string;
  event_id: string;
  sequence: number;
  state: WorkflowNodeState;
  /** The sub-agent run executing this node; joins to `sub_agent_event.child_run_id`. */
  child_run_id?: string;
  failure?: WorkflowFailure;
};

/** `workflow_finished` - the run reached a terminal state. */
export type WorkflowFinishedEvent = {
  type: 'workflow_finished';
  workflow_id: string;
  /** Redundant with `terminal_state`; the contract requires both and does not say which wins. */
  succeeded: boolean;
  run_id: string;
  event_id: string;
  sequence: number;
  terminal_state: WorkflowTerminalState;
  failure?: WorkflowFailure;
};

/**
 * `sub_agent_event` in its DURABLE form.
 *
 * The schema has two alternatives for this type. The authoritative one requires
 * `run_id`/`child_run_id`/`child_sequence`/`event_id`; the other, titled "Legacy
 * non-authoritative sub-agent compatibility event", has a `not` clause that
 * FORBIDS all of them. Darhai's own `WCoreEvent` member models only the legacy
 * shape, so the durable fields are optional at the type level and
 * {@link isDurableSubAgentEvent} decides at runtime which alternative a payload
 * satisfies. Treating them as always-present would break the legacy stream.
 */
export type DurableSubAgentEvent = {
  type: 'sub_agent_event';
  parent_call_id: string;
  agent_name: string;
  /** Serialized inner WCoreEvent from the sub-agent; opaque to this reducer. */
  inner: unknown;
  run_id: string;
  child_run_id: string;
  /** Monotonic per-child counter. Independent of the run's `sequence`. */
  child_sequence: number;
  event_id: string;
  parent_child_run_id?: string;
  /** Present on the child's final event. */
  terminal_state?: WorkflowTerminalState;
};

// ============================================
// Projection (this host's own shape - not on the wire)
// ============================================

export type WorkflowNodeSnapshot = {
  nodeId: string;
  state: WorkflowNodeState;
  childRunId?: string;
  failure?: WorkflowFailure;
};

export type WorkflowChildSnapshot = {
  childRunId: string;
  agentName: string;
  lastSequence: number;
  /**
   * Child sequences never observed, ascending. Empty on a clean stream, and
   * capped at {@link MAX_ENUMERATED_MISSING} entries - see
   * {@link WorkflowRunSnapshot.missingTotal} for why the list can be shorter
   * than the loss it describes.
   */
  missingSequences: number[];
  /** How many child sequences were never observed, counted rather than listed. */
  missingTotal: number;
  terminalState?: WorkflowTerminalState;
};

/** One run as the renderer should see it. Emitted whole on every accepted mutation. */
export type WorkflowRunSnapshot = {
  runId: string;
  workflowId: string;
  name: string;
  /**
   * The engine's declared count. NOT a completion denominator: `after-terminal`
   * opens a run with `node_count: 0` and then emits a node, and no contract rule
   * ties this number to the nodes observed. A UI rendering "1 of 0" would be
   * reporting the engine's own inconsistency as a Darhai bug, so surface
   * {@link nodes} and treat this as a hint.
   */
  nodeCount: number;
  parentRunId?: string;
  status: 'running' | WorkflowTerminalState;
  /** Highest run sequence observed on the wire, applied or rejected. */
  lastSequence: number;
  /**
   * Run sequences never observed, ascending. Non-empty means the stream lost
   * lines. Capped at {@link MAX_ENUMERATED_MISSING} entries, so this is a
   * sample of the loss, not the whole of it.
   */
  missingSequences: number[];
  /**
   * How many run sequences were never observed. Always the true count, even
   * when {@link missingSequences} was capped - it is arithmetic on the
   * sequence numbers, not a length. A UI that wants to say "N lines lost"
   * must read this and not `missingSequences.length`.
   */
  missingTotal: number;
  nodes: WorkflowNodeSnapshot[];
  children: WorkflowChildSnapshot[];
  failure?: WorkflowFailure;
};

/**
 * The stream frame type this capability emits.
 *
 * Nothing consumes it yet: no task-layer or renderer surface reads a
 * `workflow_run` frame today, so adopting this capability includes building the
 * surface that does. The name is exported so that surface and these tests agree
 * on one spelling.
 */
export const WORKFLOW_RUN_FRAME = 'workflow_run';

// ============================================
// Bounds
// ============================================

/**
 * How many runs to keep. A `Map` keyed by `run_id` with no ceiling is a slow
 * leak in a process that lives as long as a conversation does, and nothing in
 * the contract bounds how many runs a session may open. 32 is a working
 * ceiling, not a measurement - no fixture opens more than one run and the
 * binary was never observed emitting these events at all (see the plan's first
 * risk). Finished runs are evicted before live ones because their projection
 * has already been delivered; when every tracked run is still live the oldest
 * goes and the operator is told, because dropping a live run loses updates a
 * card is still showing.
 */
export const MAX_TRACKED_RUNS = 32;

/**
 * How many `event_id`s to remember per correlation key.
 *
 * The ledger is what makes a replay distinguishable from a conflict; it cannot
 * be unbounded and it cannot be a hash (a collision would make a conflicting
 * body read as identical, which fails open). Beyond this window a replay is
 * treated as a new event - it can still not rewrite a terminal node or reopen a
 * closed run, because those rules do not depend on the ledger. 512 is a choice:
 * the longest fixture is seven lines, so this is three orders of magnitude of
 * headroom over anything observed, at roughly one short string per entry.
 */
export const MAX_LEDGER_ENTRIES = 512;

/**
 * How many individual missing sequence numbers one run - or one child - will
 * ENUMERATE into its `missingSequences` list.
 *
 * WHY A CAP AT ALL. `sequence` and `child_sequence` are engine-controlled and
 * the published schema types both as a plain `integer` with no `maximum`. A
 * gap was previously filled with `for (let i = last + 1; i < sequence; i++)
 * set.add(i)`, so ONE frame carrying `sequence: 9007199254740991` spun that
 * loop nine quadrillion times inside the synchronous decode path and grew a
 * `Set` to match: a hang plus an out-of-memory from a single wire line, with no
 * malformed field for a validator to catch.
 *
 * WHAT THE ENGINE CAN ACTUALLY SEND. Every example payload and every fixture
 * starts at 0 and steps by 1; the longest workflow fixture reaches sequence 4.
 * The contract states no ceiling, so the honest reading is that the host must
 * survive any integer, not that the engine promises small ones.
 *
 * WHAT 256 IS. A CHOICE. Nothing was observed needing 256 gap entries; it is
 * picked as far more than a card can usefully list and small enough to be free.
 * The consequence WAS measured: with this cap, dispatching one
 * `sequence: 9007199254740991` node event end to end takes 0.17 ms and holds
 * 256 numbers. Change the number and that measurement is what to re-take.
 *
 * WHAT HAPPENS AT THE CAP. Enumeration stops; `missingTotal` keeps counting by
 * arithmetic, so the projection under-LISTS the loss but never under-REPORTS
 * it. The event itself is still applied - the cap changes bookkeeping detail,
 * not the accept/reject decision.
 */
export const MAX_ENUMERATED_MISSING = 256;

// ============================================
// Internal state
// ============================================

type NodeRecord = { state: WorkflowNodeState; childRunId?: string; failure?: WorkflowFailure };

/** The bounded gap bookkeeping shared by runs and children. */
type GapLedger = { missing: Set<number>; missingTotal: number };

type ChildRecord = GapLedger & {
  agentName: string;
  lastSequence: number;
  seen: Map<string, string>;
  terminalState?: WorkflowTerminalState;
};

type RunRecord = GapLedger & {
  runId: string;
  workflowId: string;
  name: string;
  nodeCount: number;
  parentRunId?: string;
  lastSequence: number;
  seen: Map<string, string>;
  terminal: { state: WorkflowTerminalState; failure?: WorkflowFailure } | null;
  nodes: Map<string, NodeRecord>;
  children: Map<string, ChildRecord>;
};

/**
 * Record the half-open range `[from, toExclusive)` as never observed.
 *
 * The total is arithmetic and therefore exact for any range the wire can
 * express; only the enumeration is bounded, by {@link MAX_ENUMERATED_MISSING}.
 * Ranges handed to this function never overlap - both callers derive `from`
 * from a counter that only moves forward - so `missing.size` is a safe measure
 * of how much room is left.
 */
function recordGap(gaps: GapLedger, from: number, toExclusive: number): void {
  if (toExclusive <= from) return;
  gaps.missingTotal += toExclusive - from;
  const room = MAX_ENUMERATED_MISSING - gaps.missing.size;
  if (room <= 0) return;
  const stop = Math.min(toExclusive, from + room);
  for (let value = from; value < stop; value += 1) gaps.missing.add(value);
}

/** A node state a later event may not contradict. `blocked` is excluded on purpose - see {@link applyNodeEvent}. */
function isTerminalNodeState(state: WorkflowNodeState): boolean {
  return state === 'succeeded' || state === 'failed';
}

/**
 * Stable serialization for the idempotency ledger.
 *
 * `JSON.stringify` preserves insertion order, so two byte-identical events that
 * arrived with their keys in a different order would compare as a conflict and
 * warn at the operator for nothing. Sorting keys at every level removes that.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The ledger key for one event.
 *
 * NAMESPACED BY TYPE, and that is the whole point. One run keeps one ledger, so
 * keying by `event_id` alone made a `workflow_node_event` that happened to
 * reuse the `workflow_started`'s id read as that started event replayed with a
 * different body - the node event was warned about and thrown away, and the
 * node it described never appeared. Two events of different types are two
 * events whatever their ids; a genuine replay carries the same type, so it
 * still lands on the same key. The separator is an escaped NUL: a JSON string
 * can only carry one as an explicit \u0000, so no event_id the decoder parsed
 * out of a wire line can forge another type's key by embedding the separator.
 */
function ledgerKey(type: string, eventId: string): string {
  return `${type}\u0000${eventId}`;
}

function remember(ledger: Map<string, string>, key: string, body: string): void {
  if (ledger.size >= MAX_LEDGER_ENTRIES) {
    const oldest = ledger.keys().next().value;
    if (oldest !== undefined) ledger.delete(oldest);
  }
  ledger.set(key, body);
}

type LedgerVerdict = 'new' | 'replay' | 'conflict';

function checkLedger(ledger: Map<string, string>, key: string, body: string): LedgerVerdict {
  const previous = ledger.get(key);
  if (previous === undefined) return 'new';
  return previous === body ? 'replay' : 'conflict';
}

// ============================================
// Runtime guards
// ============================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFailure(value: unknown): value is WorkflowFailure {
  if (!isRecord(value)) return false;
  return typeof value.code === 'string' && typeof value.message === 'string' && typeof value.retryable === 'boolean';
}

/** `failure` is optional, but a `failure` present and unreadable must not be waved through as "no failure". */
function failureIsAcceptable(value: unknown): boolean {
  return value === undefined || isFailure(value);
}

/**
 * A correlation counter: a non-negative integer.
 *
 * The schema types `sequence` and `child_sequence` as a bare `integer` with no
 * `minimum`, so a negative counter is schema-valid and `Number.isInteger` alone
 * lets it through. It is not inert: a run opened at `sequence: -3` leaves the
 * counter there, and the next legitimate event at 0 enumerates -2 and -1 into
 * `missingSequences` - the projection then reports sequence numbers that cannot
 * exist and a card would render them. Every published example and every fixture
 * starts at 0 and steps by 1, so refusing negatives costs nothing the contract
 * shows and removes a whole class of nonsense from the projection. A payload
 * that fails here is reported as malformed and never folded into a run.
 */
function isSequence(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

export function isWorkflowStarted(event: Record<string, unknown>): event is WorkflowStartedEvent {
  return (
    event.type === 'workflow_started' &&
    typeof event.workflow_id === 'string' &&
    typeof event.name === 'string' &&
    Number.isInteger(event.node_count) &&
    typeof event.run_id === 'string' &&
    typeof event.event_id === 'string' &&
    isSequence(event.sequence) &&
    (event.parent_run_id === undefined || typeof event.parent_run_id === 'string')
  );
}

const NODE_STATES: ReadonlySet<string> = new Set(['queued', 'running', 'succeeded', 'failed', 'blocked']);

export function isWorkflowNodeEvent(event: Record<string, unknown>): event is WorkflowNodeEventPayload {
  return (
    event.type === 'workflow_node_event' &&
    typeof event.run_id === 'string' &&
    typeof event.node_id === 'string' &&
    typeof event.event_id === 'string' &&
    isSequence(event.sequence) &&
    typeof event.state === 'string' &&
    NODE_STATES.has(event.state) &&
    (event.child_run_id === undefined || typeof event.child_run_id === 'string') &&
    failureIsAcceptable(event.failure)
  );
}

export function isWorkflowFinished(event: Record<string, unknown>): event is WorkflowFinishedEvent {
  return (
    event.type === 'workflow_finished' &&
    typeof event.workflow_id === 'string' &&
    typeof event.succeeded === 'boolean' &&
    typeof event.run_id === 'string' &&
    typeof event.event_id === 'string' &&
    isSequence(event.sequence) &&
    (event.terminal_state === 'succeeded' || event.terminal_state === 'failed') &&
    failureIsAcceptable(event.failure)
  );
}

/**
 * Does this payload satisfy the schema's AUTHORITATIVE `sub_agent_event`
 * alternative? A payload missing any durable field is the legacy alternative -
 * which the decoder's own `sub_agent_event` arm forwards on its own, and which
 * carries no correlation keys this reducer could use.
 *
 * A durable-SHAPED payload with a negative `child_sequence` is refused here too
 * and so takes the legacy path: its text still reaches the renderer through the
 * decoder's arm, but this reducer attributes nothing to a child whose counter
 * it cannot order.
 */
export function isDurableSubAgentEvent(event: Record<string, unknown>): event is DurableSubAgentEvent {
  return (
    event.type === 'sub_agent_event' &&
    typeof event.parent_call_id === 'string' &&
    typeof event.agent_name === 'string' &&
    event.inner !== undefined &&
    typeof event.run_id === 'string' &&
    typeof event.child_run_id === 'string' &&
    isSequence(event.child_sequence) &&
    typeof event.event_id === 'string' &&
    (event.terminal_state === undefined || event.terminal_state === 'succeeded' || event.terminal_state === 'failed') &&
    (event.parent_child_run_id === undefined || typeof event.parent_child_run_id === 'string')
  );
}

// ============================================
// Projection
// ============================================

/** Ascending copy. Optional keys are assigned rather than spread so a snapshot never carries `key: undefined`. */
function ascending(values: ReadonlySet<number>): number[] {
  return [...values].toSorted((a, b) => a - b);
}

function project(run: RunRecord): WorkflowRunSnapshot {
  const nodes: WorkflowNodeSnapshot[] = [];
  for (const [nodeId, node] of run.nodes) {
    const entry: WorkflowNodeSnapshot = { nodeId, state: node.state };
    if (node.childRunId !== undefined) entry.childRunId = node.childRunId;
    if (node.failure !== undefined) entry.failure = node.failure;
    nodes.push(entry);
  }

  const children: WorkflowChildSnapshot[] = [];
  for (const [childRunId, child] of run.children) {
    const entry: WorkflowChildSnapshot = {
      childRunId,
      agentName: child.agentName,
      lastSequence: child.lastSequence,
      missingSequences: ascending(child.missing),
      missingTotal: child.missingTotal,
    };
    if (child.terminalState !== undefined) entry.terminalState = child.terminalState;
    children.push(entry);
  }

  const snapshot: WorkflowRunSnapshot = {
    runId: run.runId,
    workflowId: run.workflowId,
    name: run.name,
    nodeCount: run.nodeCount,
    status: run.terminal ? run.terminal.state : 'running',
    lastSequence: run.lastSequence,
    missingSequences: ascending(run.missing),
    missingTotal: run.missingTotal,
    nodes,
    children,
  };
  if (run.parentRunId !== undefined) snapshot.parentRunId = run.parentRunId;
  if (run.terminal?.failure !== undefined) snapshot.failure = run.terminal.failure;
  return snapshot;
}

/**
 * Advance the run's sequence bookkeeping and report anything missing.
 *
 * JUDGEMENT CALL, and the contract does not settle it: a gap is reported and
 * the event is still applied. The alternative - drop everything until the
 * stream resynchronises - is equally defensible from the contract text, but
 * this capability declares no commands, so a host cannot ask for the missing
 * range. Dropping would leave the card frozen on whatever state it held with no
 * path back, while the information in the event that DID arrive is graded
 * `safety`. Applying costs a possibly-stale intermediate state; dropping costs
 * the run. `missingSequences` / `missingTotal` carry the damage forward so the
 * UI can say the stream lost lines rather than pretending it did not.
 *
 * Returns false when the event must not be applied at all.
 */
function advance(run: RunRecord, sequence: number, ctx: CapabilityContext, label: string): boolean {
  if (sequence <= run.lastSequence) {
    // A NEW event_id at an already-consumed sequence. The correlation key the
    // manifest publishes is `run_id_and_sequence` and it is monotonic, so this
    // is not a replay - it is a second, different event claiming a slot that is
    // already spoken for. Applying it would let a later line rewrite an earlier
    // decision, which is the whole attack surface here.
    ctx.warn(`${label} re-uses run sequence ${sequence} (already at ${run.lastSequence}) - ignoring`, {
      runId: run.runId,
    });
    return false;
  }
  if (sequence > run.lastSequence + 1) {
    recordGap(run, run.lastSequence + 1, sequence);
    ctx.warn(
      `${label} jumped from run sequence ${run.lastSequence} to ${sequence} - ${sequence - run.lastSequence - 1} event(s) lost`,
      { runId: run.runId }
    );
  }
  run.lastSequence = sequence;
  return true;
}

// ============================================
// The capability
// ============================================

/** A {@link CapabilityHandler} plus the child-stream observer, which is not dispatched by type. */
export type WorkflowLifecycleCapability = CapabilityHandler & {
  /**
   * Fold one durable `sub_agent_event` into its parent run.
   *
   * NOT in {@link CapabilityHandler.handles}, deliberately, for two reasons that
   * both end in a broken app rather than a wrong pixel. `sub_agent_event` is
   * already a first-class arm of the decoder switch (`wcore/index.ts`), so it
   * would never reach the capability dispatcher - claiming it here would declare
   * an ownership dispatch could not honour. And `durable_child_model_v1` is a
   * separate capability the manifest marks `available`, which may reasonably
   * claim the same type; two handlers claiming one type makes `assertNoOverlap`
   * throw AT MODULE LOAD, i.e. the app fails to start.
   *
   * So this stays a plain function, impossible to collide with. NOTHING CALLS
   * IT TODAY: the decoder's `sub_agent_event` arm forwards each event to the
   * task layer and asks this module nothing, so until that arm is changed the
   * child correlation below runs only under test.
   *
   * Returns `true` when the run projection changed - which is the signal that
   * arm would need in order to stop forwarding a child event this reducer
   * rejected. Because it forwards every copy unconditionally today, a
   * conflicting duplicate still reaches the renderer as text; what this function
   * can guarantee once wired is that such a copy neither advances the child's
   * correlation state nor counts as new output. Closing the rest of that gap
   * means changing the decoder, which this module does not own.
   */
  observeSubAgentEvent(event: Record<string, unknown>, ctx: CapabilityContext): boolean;
};

/**
 * Build an isolated instance.
 *
 * The module-level singleton below is the one intended for registration. Tests
 * build their own so one fixture's `workflow-run-001` cannot be another
 * fixture's - every adversarial fixture in the contract reuses that same run id,
 * so a shared module-level store would make the suite order-dependent and
 * quietly wrong.
 */
export function createWorkflowLifecycleCapability(): WorkflowLifecycleCapability {
  const runs = new Map<string, RunRecord>();

  function emit(run: RunRecord, ctx: CapabilityContext): void {
    // msg_id is '' because a run is not turn content: it opens, streams and
    // closes independently of whichever assistant message is in flight, and a
    // renderer is expected to merge updates on runId. Binding it to the active
    // turn would strand a still-running workflow under a finished message.
    ctx.emit({ type: WORKFLOW_RUN_FRAME, data: project(run), msg_id: '' });
  }

  function evictIfNeeded(ctx: CapabilityContext): void {
    while (runs.size >= MAX_TRACKED_RUNS) {
      let finished: string | undefined;
      let oldest: string | undefined;
      for (const [id, record] of runs) {
        oldest ??= id;
        if (record.terminal) {
          finished = id;
          break;
        }
      }
      // Resolved and checked BEFORE anything reads it: the warning below names
      // a run id or is not printed at all. (`runs` is non-empty whenever the
      // loop condition holds, so the guard is belt-and-braces against a future
      // edit to that condition rather than a case seen today.)
      const victim = finished ?? oldest;
      if (victim === undefined) return;
      if (finished === undefined) {
        ctx.warn(
          `evicting run "${victim}" while it is still running - ${runs.size} runs open, ceiling is ${MAX_TRACKED_RUNS}`
        );
      }
      runs.delete(victim);
    }
  }

  function applyStarted(event: WorkflowStartedEvent, ctx: CapabilityContext): boolean {
    const body = canonicalJson(event);
    const key = ledgerKey(event.type, event.event_id);
    const existing = runs.get(event.run_id);

    if (existing) {
      const verdict = checkLedger(existing.seen, key, body);
      // A byte-identical replay is a retransmit, not an attack: `event_id` is an
      // idempotency key and reconnects legitimately resend. Warning here would
      // make every reconnect look like a contract violation.
      if (verdict === 'replay') return true;
      if (verdict === 'conflict') {
        // Same idempotency key, different body. One of the two is a lie and
        // nothing in the stream says which. First-writer-wins: the first body
        // has already been shown to the user, and letting the second through is
        // precisely the retroactive rewrite this reducer exists to stop.
        ctx.warn(`workflow_started "${event.event_id}" replayed with a different body - keeping the first`, {
          runId: event.run_id,
        });
        return true;
      }
      // A second, differently-keyed open for a live run: either a reused run_id
      // or a duplicated start. Either way the existing projection is the one the
      // user is looking at, and there is no rule for merging two opens.
      ctx.warn(`workflow_started re-opens run "${event.run_id}" which is already open - ignoring`, {
        eventId: event.event_id,
      });
      return true;
    }

    evictIfNeeded(ctx);

    const run: RunRecord = {
      runId: event.run_id,
      workflowId: event.workflow_id,
      name: event.name,
      nodeCount: event.node_count,
      lastSequence: event.sequence,
      missing: new Set<number>(),
      missingTotal: 0,
      seen: new Map<string, string>(),
      terminal: null,
      nodes: new Map<string, NodeRecord>(),
      children: new Map<string, ChildRecord>(),
    };
    if (event.parent_run_id !== undefined) run.parentRunId = event.parent_run_id;
    // An open at a non-zero sequence means the lines before it never arrived.
    recordGap(run, 0, event.sequence);

    runs.set(run.runId, run);
    remember(run.seen, key, body);
    emit(run, ctx);
    return true;
  }

  /**
   * Find the run this event belongs to, or explain why it is being dropped.
   *
   * FAIL-CLOSED CHOICE: an event for an unknown run is dropped, not used to
   * synthesise one. A synthesised run has no workflow_id, no name and - worse -
   * no memory of whether that run already finished, so a stale node event
   * arriving after eviction would resurrect a closed run as a fresh "running"
   * card. The cost is real and is recorded here: a host that attaches
   * mid-stream sees nothing until the next `workflow_started`.
   */
  function runFor(runId: string, label: string, ctx: CapabilityContext): RunRecord | undefined {
    const run = runs.get(runId);
    if (!run) ctx.warn(`${label} for unknown run "${runId}" - dropping`);
    return run;
  }

  function applyNodeEvent(event: WorkflowNodeEventPayload, ctx: CapabilityContext): boolean {
    const run = runFor(event.run_id, 'workflow_node_event', ctx);
    if (!run) return true;

    const body = canonicalJson(event);
    const key = ledgerKey(event.type, event.event_id);
    const verdict = checkLedger(run.seen, key, body);
    if (verdict === 'replay') return true;
    if (verdict === 'conflict') {
      ctx.warn(`workflow_node_event "${event.event_id}" replayed with a different body - keeping the first`, {
        runId: run.runId,
        nodeId: event.node_id,
      });
      return true;
    }

    // A closed run is immutable. `workflow_finished` has already told the user
    // the run's outcome; a node transition afterwards would reopen a card the
    // user has read and, in `after-terminal.jsonl`, contradict a `succeeded`
    // run with a node that is only just starting.
    if (run.terminal) {
      ctx.warn(`workflow_node_event arrived after run "${run.runId}" finished (${run.terminal.state}) - ignoring`, {
        nodeId: event.node_id,
        state: event.state,
      });
      return true;
    }

    // Sequence bookkeeping happens before the node rules so it counts what was
    // seen on the wire, not what was applied - otherwise rejecting one line
    // makes the next legitimate one read as a gap.
    if (!advance(run, event.sequence, ctx, 'workflow_node_event')) return true;

    const previous = run.nodes.get(event.node_id);
    if (previous && isTerminalNodeState(previous.state) && previous.state !== event.state) {
      // `blocked` is NOT treated as terminal: a blocked node is waiting on
      // something (an approval, a lease) and the schema gives no rule forbidding
      // it from running later. Only succeeded/failed are final, and once a node
      // is final nothing may move it - this is the guarantee the capability's
      // user-facing promise rests on.
      ctx.warn(
        `node "${event.node_id}" already ${previous.state}; refusing to change it to ${event.state}`,
        event.failure ? { runId: run.runId, failure: event.failure } : { runId: run.runId }
      );
      remember(run.seen, key, body);
      return true;
    }
    if (previous && previous.state === event.state) {
      // Same outcome restated under a new event_id: nothing to change, nothing
      // to complain about.
      remember(run.seen, key, body);
      return true;
    }

    const node: NodeRecord = { state: event.state };
    if (event.child_run_id !== undefined) node.childRunId = event.child_run_id;
    else if (previous?.childRunId !== undefined) node.childRunId = previous.childRunId;
    if (event.failure !== undefined) node.failure = event.failure;
    run.nodes.set(event.node_id, node);

    remember(run.seen, key, body);
    emit(run, ctx);
    return true;
  }

  function applyFinished(event: WorkflowFinishedEvent, ctx: CapabilityContext): boolean {
    const run = runFor(event.run_id, 'workflow_finished', ctx);
    if (!run) return true;

    const body = canonicalJson(event);
    const key = ledgerKey(event.type, event.event_id);
    const verdict = checkLedger(run.seen, key, body);
    if (verdict === 'replay') return true;
    if (verdict === 'conflict') {
      ctx.warn(`workflow_finished "${event.event_id}" replayed with a different body - keeping the first`, {
        runId: run.runId,
      });
      return true;
    }

    if (run.terminal) {
      ctx.warn(`run "${run.runId}" is already ${run.terminal.state}; refusing to close it as ${event.terminal_state}`);
      return true;
    }

    if (!advance(run, event.sequence, ctx, 'workflow_finished')) return true;

    // The contract requires BOTH `succeeded` and `terminal_state` and does not
    // say which wins when they disagree. No fixture makes them contradict, so
    // this path is defensive: report the disagreement and take the pessimistic
    // reading. Showing a run as succeeded on evidence that contradicts itself is
    // the failure that costs the user; showing failed is visible and arguable.
    const agrees = event.succeeded === (event.terminal_state === 'succeeded');
    if (!agrees) {
      ctx.warn(
        `workflow_finished contradicts itself (succeeded=${event.succeeded}, terminal_state=${event.terminal_state}) - reporting failed`,
        { runId: run.runId }
      );
    }
    run.terminal = { state: agrees ? event.terminal_state : 'failed' };
    if (event.failure !== undefined) run.terminal.failure = event.failure;

    remember(run.seen, key, body);
    emit(run, ctx);
    return true;
  }

  function observeSubAgentEvent(event: Record<string, unknown>, rawCtx: CapabilityContext): boolean {
    // This entry point is not reached through `createDispatcher`, which is what
    // stamps `[capability]` onto every other message this module emits. Without
    // re-applying it here a child-stream warning would be the one line in the
    // operator's log with no owner on it.
    const ctx: CapabilityContext = {
      ...rawCtx,
      log: (message, detail) => rawCtx.log(`[${CAPABILITY_NAME}] ${message}`, detail),
      warn: (message, detail) => rawCtx.warn(`[${CAPABILITY_NAME}] ${message}`, detail),
    };

    // The legacy alternative carries no correlation keys; it is the decoder's to
    // forward and nothing here can attribute it to a run.
    if (!isDurableSubAgentEvent(event)) return false;

    const run = runs.get(event.run_id);
    if (!run) return false;

    const child = run.children.get(event.child_run_id);
    const body = canonicalJson(event);
    const key = ledgerKey(event.type, event.event_id);

    if (child) {
      const verdict = checkLedger(child.seen, key, body);
      if (verdict === 'replay') return false;
      if (verdict === 'conflict') {
        // `child-duplicate-conflict.jsonl`: same child_run_id + child_sequence +
        // event_id, different `inner`. The child's output is what the user reads
        // as the node's work; letting the second body win would rewrite text
        // already on screen.
        ctx.warn(`sub_agent_event "${event.event_id}" replayed with a different body - keeping the first`, {
          runId: run.runId,
          childRunId: event.child_run_id,
        });
        return false;
      }
    }

    // A closed run is immutable, and that has to include the child stream or the
    // promise is decoration. `workflow_finished` has already told the user the
    // run's outcome; folding a straggler child event in afterwards adds output -
    // or a fresh child card - to a run the user has finished reading, which is
    // the same retroactive rewrite `applyNodeEvent` refuses one branch above.
    // The event still reaches the renderer as text through the decoder's own
    // arm; what it may not do is move this run's projection.
    if (run.terminal) {
      ctx.warn(`sub_agent_event arrived after run "${run.runId}" finished (${run.terminal.state}) - ignoring`, {
        childRunId: event.child_run_id,
        childSequence: event.child_sequence,
      });
      return false;
    }

    if (child) {
      if (event.child_sequence <= child.lastSequence) {
        // The mirror of the run-level rule in `advance`, and needed for the same
        // reason: `child_run_id_and_child_sequence` is the published correlation
        // key, so a NEW event_id at a consumed child sequence is a second event
        // claiming a filled slot, not a retransmit.
        ctx.warn(
          `sub_agent_event re-uses child sequence ${event.child_sequence} (already at ${child.lastSequence}) - ignoring`,
          { runId: run.runId, childRunId: event.child_run_id }
        );
        return false;
      }
      if (event.child_sequence > child.lastSequence + 1) {
        recordGap(child, child.lastSequence + 1, event.child_sequence);
        ctx.warn(
          `sub_agent_event jumped from child sequence ${child.lastSequence} to ${event.child_sequence} - output lost`,
          { runId: run.runId, childRunId: event.child_run_id }
        );
      }
      child.lastSequence = event.child_sequence;
      if (event.terminal_state !== undefined) child.terminalState = event.terminal_state;
      remember(child.seen, key, body);
      emit(run, ctx);
      return true;
    }

    const created: ChildRecord = {
      agentName: event.agent_name,
      lastSequence: event.child_sequence,
      missing: new Set<number>(),
      missingTotal: 0,
      seen: new Map<string, string>(),
    };
    // `child-sequence-gap.jsonl`: the child's first observed event is
    // child_sequence 1, so sequence 0 - the start of that node's output - never
    // arrived. Every published example and fixture starts a child at 0, so the
    // loss is countable from the first event alone.
    recordGap(created, 0, event.child_sequence);
    if (created.missingTotal > 0) {
      ctx.warn(`sub_agent_event stream for "${event.child_run_id}" starts at ${event.child_sequence} - output lost`, {
        runId: run.runId,
      });
    }
    if (event.terminal_state !== undefined) created.terminalState = event.terminal_state;
    remember(created.seen, key, body);
    run.children.set(event.child_run_id, created);
    emit(run, ctx);
    return true;
  }

  return {
    name: CAPABILITY_NAME,
    handles: ['workflow_started', 'workflow_node_event', 'workflow_finished'],
    handle(event, ctx) {
      switch (event.type) {
        case 'workflow_started':
          if (!isWorkflowStarted(event)) break;
          return applyStarted(event, ctx);
        case 'workflow_node_event':
          if (!isWorkflowNodeEvent(event)) break;
          return applyNodeEvent(event, ctx);
        case 'workflow_finished':
          if (!isWorkflowFinished(event)) break;
          return applyFinished(event, ctx);
        default:
          return false;
      }
      // A payload of a type we own that does not satisfy the schema's required
      // fields. Returning false rather than true is the honest answer: nothing
      // was decided, so the decoder still gets to log it as unhandled. A
      // half-read safety event must never be folded into a run.
      ctx.warn(`malformed ${String(event.type)} - required fields missing or wrong type`, event);
      return false;
    },
    observeSubAgentEvent,
  };
}

/**
 * The instance intended for registration.
 *
 * `HANDLERS` in `capabilities/index.ts` is empty today, so nothing dispatches to
 * this object yet - see WIRING REQUIRED at the top of this file. It is a
 * singleton because a capability's state must outlive one decode call, not
 * because anything currently holds it.
 */
export const workflowLifecycleCapability: WorkflowLifecycleCapability = createWorkflowLifecycleCapability();
