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
 * WHY A REDUCER AND NOT A PASS-THROUGH. Before this module the three types sat
 * in `ACKNOWLEDGED_UNHANDLED_EVENTS` and were dropped without a warning: a
 * workflow node that failed produced a conversation that simply went quiet. But
 * forwarding them raw would be worse than silence, because the stream can
 * contradict itself. The eight adversarial fixtures under
 * `adversarial/workflow/` are exactly those contradictions - a duplicate
 * `event_id` carrying a different body, a node event arriving after the run was
 * closed, a second terminal for a node that already succeeded. A card that can
 * be flipped from succeeded to failed by a later line is a card that lies, and
 * `safety` is the grade the contract puts on that.
 *
 * WHAT THE CONTRACT DOES NOT SETTLE. The manifest publishes correlation keys and
 * criticality; it does not publish a verdict per fixture, and
 * `tests/helpers/engineContract.ts` says so in as many words. Every rule below
 * therefore carries its own justification, and where two readings were
 * defensible the conservative one was taken and labelled. This capability
 * declares no commands (`manifest.commands` for it is empty), so the host has no
 * way to ask the engine to resend anything - that single fact decides the
 * sequence-gap rule below.
 */

import type { CapabilityContext, CapabilityHandler } from './types';

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
  /** Monotonic per-child counter, starts at 0. Independent of the run's `sequence`. */
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
  /** Child sequences never observed. Empty on a clean stream. */
  missingSequences: number[];
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
  /** Run sequences never observed. Non-empty means the stream lost lines. */
  missingSequences: number[];
  nodes: WorkflowNodeSnapshot[];
  children: WorkflowChildSnapshot[];
  failure?: WorkflowFailure;
};

/** The stream frame type this capability emits. The task layer forwards it by this name. */
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
 * has already been delivered.
 */
const MAX_TRACKED_RUNS = 32;

/**
 * How many `event_id`s to remember per correlation key.
 *
 * The ledger is what makes a replay distinguishable from a conflict; it cannot
 * be unbounded and it cannot be a hash (a collision would make a conflicting
 * body read as identical, which fails open). Beyond this window a replay is
 * treated as a new event - it can still not rewrite a terminal node or reopen a
 * closed run, because those rules do not depend on the ledger.
 */
const MAX_LEDGER_ENTRIES = 512;

// ============================================
// Internal state
// ============================================

type NodeRecord = { state: WorkflowNodeState; childRunId?: string; failure?: WorkflowFailure };

type ChildRecord = {
  agentName: string;
  lastSequence: number;
  missing: Set<number>;
  seen: Map<string, string>;
  terminalState?: WorkflowTerminalState;
};

type RunRecord = {
  runId: string;
  workflowId: string;
  name: string;
  nodeCount: number;
  parentRunId?: string;
  lastSequence: number;
  missing: Set<number>;
  seen: Map<string, string>;
  terminal: { state: WorkflowTerminalState; failure?: WorkflowFailure } | null;
  nodes: Map<string, NodeRecord>;
  children: Map<string, ChildRecord>;
};

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

function remember(ledger: Map<string, string>, eventId: string, body: string): void {
  if (ledger.size >= MAX_LEDGER_ENTRIES) {
    const oldest = ledger.keys().next().value;
    if (oldest !== undefined) ledger.delete(oldest);
  }
  ledger.set(eventId, body);
}

type LedgerVerdict = 'new' | 'replay' | 'conflict';

function checkLedger(ledger: Map<string, string>, eventId: string, body: string): LedgerVerdict {
  const previous = ledger.get(eventId);
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

export function isWorkflowStarted(event: Record<string, unknown>): event is WorkflowStartedEvent {
  return (
    event.type === 'workflow_started' &&
    typeof event.workflow_id === 'string' &&
    typeof event.name === 'string' &&
    Number.isInteger(event.node_count) &&
    typeof event.run_id === 'string' &&
    typeof event.event_id === 'string' &&
    Number.isInteger(event.sequence) &&
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
    Number.isInteger(event.sequence) &&
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
    Number.isInteger(event.sequence) &&
    (event.terminal_state === 'succeeded' || event.terminal_state === 'failed') &&
    failureIsAcceptable(event.failure)
  );
}

/**
 * Does this payload satisfy the schema's AUTHORITATIVE `sub_agent_event`
 * alternative? A payload missing any durable field is the legacy alternative -
 * which the decoder's own `sub_agent_event` arm already forwards, and which
 * carries no correlation keys this reducer could use.
 */
export function isDurableSubAgentEvent(event: Record<string, unknown>): event is DurableSubAgentEvent {
  return (
    event.type === 'sub_agent_event' &&
    typeof event.parent_call_id === 'string' &&
    typeof event.agent_name === 'string' &&
    event.inner !== undefined &&
    typeof event.run_id === 'string' &&
    typeof event.child_run_id === 'string' &&
    Number.isInteger(event.child_sequence) &&
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
 * the run. `missingSequences` carries the damage forward so the UI can say the
 * stream lost lines rather than pretending it did not.
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
    for (let missing = run.lastSequence + 1; missing < sequence; missing += 1) run.missing.add(missing);
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
   * never reaches the capability dispatcher at all - claiming it here would
   * declare an ownership that dispatch could not honour. And
   * `durable_child_model_v1` is a separate available capability that may
   * reasonably claim the same type; two handlers claiming one type makes
   * `assertNoOverlap` throw AT MODULE LOAD, i.e. the app fails to start.
   *
   * So this stays a plain function: inert until the decoder's `sub_agent_event`
   * arm calls it, and impossible to collide with.
   *
   * Returns `true` when the run projection changed - which is also the signal
   * the decoder's arm needs if it is ever to stop forwarding a child event this
   * reducer rejected. Today that arm forwards every copy, so a conflicting
   * duplicate still reaches the renderer as text; what this function guarantees
   * is that it cannot advance the child's correlation state or count as new
   * output. Closing that gap means changing the decoder, which this module does
   * not own.
   */
  observeSubAgentEvent(event: Record<string, unknown>, ctx: CapabilityContext): boolean;
};

/**
 * Build an isolated instance.
 *
 * Production uses the singleton below. Tests build their own so one fixture's
 * `workflow-run-001` cannot be another fixture's - every adversarial fixture in
 * the contract reuses that same run id, so a shared module-level store would
 * make the suite order-dependent and quietly wrong.
 */
export function createWorkflowLifecycleCapability(): WorkflowLifecycleCapability {
  const runs = new Map<string, RunRecord>();

  function emit(run: RunRecord, ctx: CapabilityContext): void {
    // msg_id is '' because a run is not turn content: it opens, streams and
    // closes independently of whichever assistant message is in flight, and the
    // renderer merges updates on runId. Binding it to the active turn would
    // strand a still-running workflow under a finished message.
    ctx.emit({ type: WORKFLOW_RUN_FRAME, data: project(run), msg_id: '' });
  }

  function evictIfNeeded(ctx: CapabilityContext): void {
    while (runs.size >= MAX_TRACKED_RUNS) {
      let victim: string | undefined;
      for (const [id, record] of runs) {
        if (record.terminal) {
          victim = id;
          break;
        }
      }
      if (victim === undefined) {
        victim = runs.keys().next().value;
        ctx.warn(`evicting run "${victim}" while it is still running - more than ${MAX_TRACKED_RUNS} runs are open`);
      }
      if (victim === undefined) return;
      runs.delete(victim);
    }
  }

  function applyStarted(event: WorkflowStartedEvent, ctx: CapabilityContext): boolean {
    const body = canonicalJson(event);
    const existing = runs.get(event.run_id);

    if (existing) {
      const verdict = checkLedger(existing.seen, event.event_id, body);
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
      seen: new Map<string, string>(),
      terminal: null,
      nodes: new Map<string, NodeRecord>(),
      children: new Map<string, ChildRecord>(),
    };
    if (event.parent_run_id !== undefined) run.parentRunId = event.parent_run_id;
    // An open at a non-zero sequence means the lines before it never arrived.
    for (let missing = 0; missing < event.sequence; missing += 1) run.missing.add(missing);

    runs.set(run.runId, run);
    remember(run.seen, event.event_id, body);
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
    const verdict = checkLedger(run.seen, event.event_id, body);
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
      remember(run.seen, event.event_id, body);
      return true;
    }
    if (previous && previous.state === event.state) {
      // Same outcome restated under a new event_id: nothing to change, nothing
      // to complain about.
      remember(run.seen, event.event_id, body);
      return true;
    }

    const node: NodeRecord = { state: event.state };
    if (event.child_run_id !== undefined) node.childRunId = event.child_run_id;
    else if (previous?.childRunId !== undefined) node.childRunId = previous.childRunId;
    if (event.failure !== undefined) node.failure = event.failure;
    run.nodes.set(event.node_id, node);

    remember(run.seen, event.event_id, body);
    emit(run, ctx);
    return true;
  }

  function applyFinished(event: WorkflowFinishedEvent, ctx: CapabilityContext): boolean {
    const run = runFor(event.run_id, 'workflow_finished', ctx);
    if (!run) return true;

    const body = canonicalJson(event);
    const verdict = checkLedger(run.seen, event.event_id, body);
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

    remember(run.seen, event.event_id, body);
    emit(run, ctx);
    return true;
  }

  function observeSubAgentEvent(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
    // The legacy alternative carries no correlation keys; it is the decoder's to
    // forward and nothing here can attribute it to a run.
    if (!isDurableSubAgentEvent(event)) return false;

    const run = runs.get(event.run_id);
    if (!run) return false;

    const child = run.children.get(event.child_run_id);
    const body = canonicalJson(event);

    if (child) {
      const verdict = checkLedger(child.seen, event.event_id, body);
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
      if (event.child_sequence <= child.lastSequence) {
        ctx.warn(
          `sub_agent_event re-uses child sequence ${event.child_sequence} (already at ${child.lastSequence}) - ignoring`,
          { runId: run.runId, childRunId: event.child_run_id }
        );
        return false;
      }
      if (event.child_sequence > child.lastSequence + 1) {
        for (let missing = child.lastSequence + 1; missing < event.child_sequence; missing += 1)
          child.missing.add(missing);
        ctx.warn(
          `sub_agent_event jumped from child sequence ${child.lastSequence} to ${event.child_sequence} - output lost`,
          { runId: run.runId, childRunId: event.child_run_id }
        );
      }
      child.lastSequence = event.child_sequence;
      if (event.terminal_state !== undefined) child.terminalState = event.terminal_state;
      remember(child.seen, event.event_id, body);
      emit(run, ctx);
      return true;
    }

    const created: ChildRecord = {
      agentName: event.agent_name,
      lastSequence: event.child_sequence,
      missing: new Set<number>(),
      seen: new Map<string, string>(),
    };
    // `child-sequence-gap.jsonl`: the child's first observed event is
    // child_sequence 1, so sequence 0 - the start of that node's output - never
    // arrived. The counter starts at 0 per the contract, so this is countable.
    for (let missing = 0; missing < event.child_sequence; missing += 1) created.missing.add(missing);
    if (created.missing.size > 0) {
      ctx.warn(`sub_agent_event stream for "${event.child_run_id}" starts at ${event.child_sequence} - output lost`, {
        runId: run.runId,
      });
    }
    if (event.terminal_state !== undefined) created.terminalState = event.terminal_state;
    remember(created.seen, event.event_id, body);
    run.children.set(event.child_run_id, created);
    emit(run, ctx);
    return true;
  }

  return {
    name: 'workflow_lifecycle_v1',
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

/** The registered instance. `capabilities/index.ts` puts this in `HANDLERS`. */
export const workflowLifecycleCapability: WorkflowLifecycleCapability = createWorkflowLifecycleCapability();
