/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `workflow_lifecycle_v1` - the reducer, driven by the engine's own fixtures.
 *
 * Every case in the first half replays a real file from
 * `tests/fixtures/engine-contract/desktop/v1/adversarial/workflow/` line by
 * line, in order, through the SAME `createDispatcher` production would use.
 * Nothing there is a hand-written approximation of what the engine sends. The
 * second half covers rules the fixtures imply but do not exercise, plus the
 * module's own self-imposed bounds, and every block in it says so.
 *
 * A note on verdicts. The contract publishes correlation keys and a criticality
 * grade; it does NOT publish "accept this fixture, reject that one", and
 * `tests/helpers/engineContract.ts` warns in its own header that fixture names
 * are not an oracle - `duplicate-identical` is a case a host should TOLERATE.
 * So each block below states its verdict and argues it from the manifest, the
 * schema, or the fixture body. Where two readings were defensible (the sequence
 * gap) the block says so rather than dressing a judgement call up as a rule.
 *
 * A note on what is NOT proven here. The capability is not registered:
 * `HANDLERS` in `capabilities/index.ts` is empty, the decoder's
 * `sub_agent_event` arm does not call `observeSubAgentEvent`, and nothing
 * renders a `workflow_run` frame. These tests therefore prove the reducer's
 * behaviour under the routing the module REQUIRES, not that the routing exists.
 * `declines the child event type at the dispatcher` below pins the one half of
 * that split which is already true today.
 */

import { describe, expect, it } from 'vitest';

import { createDispatcher } from '@process/agent/wcore/capabilities';
import type { CapabilityContext, CapabilityStreamFrame } from '@process/agent/wcore/capabilities/types';
import {
  createWorkflowLifecycleCapability,
  isDurableSubAgentEvent,
  isWorkflowFinished,
  isWorkflowNodeEvent,
  isWorkflowStarted,
  MAX_ENUMERATED_MISSING,
  MAX_LEDGER_ENTRIES,
  MAX_TRACKED_RUNS,
  WORKFLOW_RUN_FRAME,
} from '@process/agent/wcore/capabilities/handlers/workflowLifecycle';
import type { WorkflowRunSnapshot } from '@process/agent/wcore/capabilities/handlers/workflowLifecycle';
import { adversarialFixtures, examplePayload, readFixture, surfaceOf, validateEvent } from '../helpers/engineContract';

/** Every warning this module emits carries this, whether dispatched or called directly. */
const PREFIX = '[workflow_lifecycle_v1] ';

type Recorder = CapabilityContext & {
  frames: CapabilityStreamFrame[];
  warns: string[];
  logs: string[];
};

function makeContext(): Recorder {
  const frames: CapabilityStreamFrame[] = [];
  const warns: string[] = [];
  const logs: string[] = [];
  return {
    frames,
    warns,
    logs,
    sendCommand: () => {},
    emit: (f) => frames.push(f),
    activeMsgId: () => 'msg-in-flight',
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  };
}

const fixture = (name: string) => `adversarial/workflow/${name}.jsonl`;

const lastSnapshot = (ctx: Recorder): WorkflowRunSnapshot =>
  ctx.frames[ctx.frames.length - 1].data as WorkflowRunSnapshot;

type Replay = {
  ctx: Recorder;
  /** Per line: did the host consume it? */
  consumed: boolean[];
  snapshots: WorkflowRunSnapshot[];
  final: WorkflowRunSnapshot;
};

/**
 * Replay a fixture under the routing this module requires.
 *
 * `sub_agent_event` goes to `observeSubAgentEvent` rather than through the
 * dispatcher because the decoder owns that type in its own switch arm, so it
 * can never reach the capability dispatcher. That much is true today. What is
 * NOT true today is that anything calls `observeSubAgentEvent` at all - the
 * decoder's arm forwards the event and asks this module nothing. Changing that
 * arm is out of this module's scope, so this helper models the target routing
 * and `declines the child event type at the dispatcher` pins the half of it
 * that already holds.
 */
function replay(relPath: string): Replay {
  const capability = createWorkflowLifecycleCapability();
  const dispatch = createDispatcher([capability]);
  const ctx = makeContext();
  const consumed: boolean[] = [];

  for (const line of readFixture(relPath)) {
    consumed.push(line.type === 'sub_agent_event' ? capability.observeSubAgentEvent(line, ctx) : dispatch(line, ctx));
  }

  const snapshots = ctx.frames.map((f) => f.data as WorkflowRunSnapshot);
  return { ctx, consumed, snapshots, final: snapshots[snapshots.length - 1] };
}

// ============================================
// The contract surface this capability answers for
// ============================================

describe('contract surface', () => {
  it('covers every event the manifest assigns to workflow_lifecycle_v1', () => {
    const types = surfaceOf('workflow_lifecycle_v1')
      .events.map((e) => e.type)
      .toSorted();
    expect(types).toEqual(['sub_agent_event', 'workflow_finished', 'workflow_node_event', 'workflow_started']);
  });

  /**
   * The reducer is strict because the contract says these events are
   * safety-graded and correlate on a key the host must enforce. If an engine
   * bump downgrades either, the strictness needs re-justifying rather than
   * silently outliving its reason.
   */
  it('still grades all four as safety, with the two correlation keys the reducer implements', () => {
    const byType = new Map(surfaceOf('workflow_lifecycle_v1').events.map((e) => [e.type, e]));
    for (const [type, entry] of byType) {
      expect(entry.criticality, `${type} criticality`).toBe('safety');
    }
    expect(byType.get('workflow_started')?.correlation).toBe('run_id_and_sequence');
    expect(byType.get('workflow_node_event')?.correlation).toBe('run_id_and_sequence');
    expect(byType.get('workflow_finished')?.correlation).toBe('run_id_and_sequence');
    expect(byType.get('sub_agent_event')?.correlation).toBe('child_run_id_and_child_sequence');
  });

  /** No commands means no way to ask for a lost line back - the whole basis of the gap rule below. */
  it('declares no commands, which is what makes the sequence-gap verdict apply-and-flag', () => {
    expect(surfaceOf('workflow_lifecycle_v1').commands).toEqual([]);
  });

  it('claims the three run types and deliberately not sub_agent_event', () => {
    const capability = createWorkflowLifecycleCapability();
    expect([...capability.handles].toSorted()).toEqual([
      'workflow_finished',
      'workflow_node_event',
      'workflow_started',
    ]);
    // Claiming it would collide with the decoder's own arm and, if
    // durable_child_model_v1 claims it too, make assertNoOverlap throw at module
    // load - an app that does not start.
    expect(capability.handles).not.toContain('sub_agent_event');
  });

  it('declines the child event type at the dispatcher, matching production routing', () => {
    const capability = createWorkflowLifecycleCapability();
    const dispatch = createDispatcher([capability]);
    const child = readFixture(fixture('valid-lifecycle')).find((l) => l.type === 'sub_agent_event');
    expect(child, 'fixture should contain a sub_agent_event line').toBeDefined();
    expect(dispatch(child as Record<string, unknown>, makeContext())).toBe(false);
  });

  /**
   * The guards must agree with the schema, in both directions: the engine's own
   * example has to pass, and the legacy sub-agent shape - schema-valid but
   * carrying no correlation keys - has to be refused.
   */
  it('accepts every published example payload, and the schema accepts them too', () => {
    for (const type of ['workflow_started', 'workflow_node_event', 'workflow_finished', 'sub_agent_event']) {
      const payload = examplePayload('event', type);
      const { valid, errors } = validateEvent(payload);
      expect(valid, `${type} example failed schema: ${errors.join('; ')}`).toBe(true);
    }
    expect(isWorkflowStarted(examplePayload('event', 'workflow_started'))).toBe(true);
    expect(isWorkflowNodeEvent(examplePayload('event', 'workflow_node_event'))).toBe(true);
    expect(isWorkflowFinished(examplePayload('event', 'workflow_finished'))).toBe(true);
    expect(isDurableSubAgentEvent(examplePayload('event', 'sub_agent_event'))).toBe(true);
  });

  it('refuses the legacy sub-agent shape, which the schema still considers valid', () => {
    const legacy = {
      type: 'sub_agent_event',
      parent_call_id: 'call-1',
      agent_name: 'scan',
      inner: { type: 'text_delta', msg_id: 'm', text: 'x' },
    };
    expect(validateEvent(legacy).valid, 'legacy alternative should be schema-valid').toBe(true);
    expect(isDurableSubAgentEvent(legacy)).toBe(false);
  });

  /**
   * Every adversarial line is well-formed JSON that satisfies the published
   * schema. That is what makes them interesting: each one is a SEMANTIC attack,
   * so a host cannot dismiss any of them with a validator.
   */
  it('every workflow fixture line is schema-valid', () => {
    const files = adversarialFixtures('workflow');
    expect(files.length, 'contract shipped no workflow fixtures').toBe(8);
    for (const file of files) {
      for (const [index, line] of readFixture(file).entries()) {
        const { valid, errors } = validateEvent(line);
        expect(valid, `${file}:${index + 1} ${errors.join('; ')}`).toBe(true);
      }
    }
  });
});

// ============================================
// valid-lifecycle - the baseline every rule must not break
// ============================================

describe('valid-lifecycle: VERDICT accept all seven lines', () => {
  it('produces one frame per accepted line and never warns', () => {
    const { ctx, consumed } = replay(fixture('valid-lifecycle'));
    expect(consumed).toEqual([true, true, true, true, true, true, true]);
    expect(ctx.warns, `unexpected warnings: ${ctx.warns.join(' | ')}`).toEqual([]);
    expect(ctx.frames).toHaveLength(7);
    expect(ctx.frames.every((f) => f.type === WORKFLOW_RUN_FRAME)).toBe(true);
  });

  it('closes the run succeeded with its node succeeded', () => {
    const { final } = replay(fixture('valid-lifecycle'));
    expect(final.status).toBe('succeeded');
    expect(final.runId).toBe('workflow-run-001');
    expect(final.workflowId).toBe('desktop-audit');
    expect(final.name).toBe('Desktop audit');
    expect(final.nodes).toEqual([{ nodeId: 'scan', state: 'succeeded', childRunId: 'child-run-001' }]);
    expect(final.missingSequences).toEqual([]);
    expect(final.missingTotal).toBe(0);
  });

  /**
   * THE TRAP IN THIS FIXTURE. Two `sub_agent_event` lines sit between run
   * sequences 2 and 3 and carry no `sequence` of their own - the manifest
   * correlates them on `child_run_id_and_child_sequence` instead. A reducer that
   * folded them into the run counter would leave it at 4, and the perfectly
   * legal `workflow_node_event` at sequence 3 would then read as an out-of-order
   * line and be dropped: the node would be stuck on `running` forever.
   */
  it('keeps the child counter separate from the run counter', () => {
    const { final, ctx } = replay(fixture('valid-lifecycle'));
    expect(final.lastSequence).toBe(4);
    expect(final.children).toEqual([
      {
        childRunId: 'child-run-001',
        agentName: 'scan',
        lastSequence: 1,
        missingSequences: [],
        missingTotal: 0,
        terminalState: 'succeeded',
      },
    ]);
    expect(ctx.warns.filter((w) => w.includes('sequence'))).toEqual([]);
  });

  /** The frame is not turn content: a run outlives the message that started it. */
  it('emits with an empty msg_id rather than binding the run to the turn in flight', () => {
    const { ctx } = replay(fixture('valid-lifecycle'));
    expect(ctx.frames.map((f) => f.msg_id)).toEqual(['', '', '', '', '', '', '']);
  });
});

// ============================================
// duplicate-identical - VERDICT: tolerate
// ============================================

/**
 * `event_id` is an idempotency key. A byte-identical second copy is a
 * retransmit - reconnects legitimately resend - so the correct host behaviour is
 * to consume it, change nothing, and stay quiet. Warning here would make every
 * reconnect look like a contract violation and train operators to ignore the
 * warning that matters.
 */
describe('duplicate-identical: VERDICT tolerate silently', () => {
  it('consumes both lines but emits and warns only once', () => {
    const { ctx, consumed } = replay(fixture('duplicate-identical'));
    expect(consumed).toEqual([true, true]);
    expect(ctx.frames).toHaveLength(1);
    expect(ctx.warns).toEqual([]);
  });

  it('leaves the run exactly as the first copy described it', () => {
    const { final } = replay(fixture('duplicate-identical'));
    expect(final.name).toBe('Desktop audit');
    expect(final.status).toBe('running');
    expect(final.lastSequence).toBe(0);
  });
});

// ============================================
// duplicate-conflict - VERDICT: reject the second body
// ============================================

/**
 * Same `event_id`, different `name`. One of the two bodies is a lie and the
 * stream gives no way to tell which, so first-writer-wins: the first name has
 * already been rendered, and accepting the second is exactly the retroactive
 * rewrite a `safety`-graded correlation key exists to prevent. The event is
 * still consumed (we decided about it), and the operator is told.
 */
describe('duplicate-conflict: VERDICT reject the conflicting body, warn once', () => {
  it('keeps the first display name', () => {
    const { final } = replay(fixture('duplicate-conflict'));
    expect(final.name).toBe('Desktop audit');
    expect(final.name).not.toBe('Conflicting display name');
  });

  it('warns exactly once and emits no second frame', () => {
    const { ctx } = replay(fixture('duplicate-conflict'));
    expect(ctx.warns).toHaveLength(1);
    expect(ctx.warns[0]).toContain('different body');
    expect(ctx.frames).toHaveLength(1);
  });
});

// ============================================
// sequence-gap - VERDICT: apply AND report (judgement call)
// ============================================

/**
 * JUDGEMENT CALL, recorded as one. The node event arrives at run sequence 2
 * while the run is at 0, so sequence 1 never landed. Two readings are defensible
 * from the contract, which says only that the correlation key is
 * `run_id_and_sequence`:
 *
 *   apply-and-flag (chosen) - the event that DID arrive is safety-graded
 *     information, and `manifest.commands` for this capability is EMPTY (pinned
 *     above), so a host has no verb with which to request the missing range.
 *     Dropping would freeze the card with no path back.
 *   drop-until-resynced - refuses to show state derived from an incomplete
 *     stream.
 *
 * The two produce visibly different UI, so the gap is carried in
 * `missingSequences` / `missingTotal` rather than being swallowed either way.
 */
describe('sequence-gap: VERDICT apply the event and report the gap', () => {
  it('applies the node transition that did arrive', () => {
    const { final, consumed } = replay(fixture('sequence-gap'));
    expect(consumed).toEqual([true, true]);
    expect(final.nodes).toEqual([{ nodeId: 'scan', state: 'running', childRunId: 'child-run-001' }]);
    expect(final.lastSequence).toBe(2);
  });

  it('names the missing sequence instead of pretending the stream was whole', () => {
    const { final, ctx } = replay(fixture('sequence-gap'));
    expect(final.missingSequences).toEqual([1]);
    expect(final.missingTotal).toBe(1);
    expect(ctx.warns).toHaveLength(1);
    expect(ctx.warns[0]).toContain('jumped from run sequence 0 to 2');
  });
});

// ============================================
// after-terminal - VERDICT: reject
// ============================================

/**
 * `workflow_finished` closed the run at sequence 1; a node event then arrives at
 * sequence 2 saying a node is only just `running`. The user has already been
 * told the run succeeded. Reopening it would contradict a delivered result, so a
 * closed run is immutable.
 */
describe('after-terminal: VERDICT reject anything after the run closed', () => {
  it('leaves the finished run untouched', () => {
    const { ctx, final, consumed } = replay(fixture('after-terminal'));
    expect(consumed).toEqual([true, true, true]);
    expect(ctx.frames).toHaveLength(2);
    expect(final.status).toBe('succeeded');
    expect(final.nodes).toEqual([]);
    expect(ctx.warns).toHaveLength(1);
    expect(ctx.warns[0]).toContain('after run');
  });

  /**
   * This fixture also opens its run with `node_count: 0` and then emits a node.
   * Nothing in the contract ties the declared count to the nodes observed, so
   * the count is carried as-is and the observed node list is what a card should
   * render - "1 of 0" would report the engine's inconsistency as a Darhai bug.
   */
  it('carries node_count verbatim without deriving progress from it', () => {
    const { final } = replay(fixture('after-terminal'));
    expect(final.nodeCount).toBe(0);
    expect(final.nodes.length).toBe(0);
  });
});

// ============================================
// conflicting-node-terminal - VERDICT: reject the second terminal
// ============================================

/**
 * The node reaches `succeeded` at sequence 1 and a later line declares the same
 * node `failed` with `failure.code = stage_failed`. This is the case the
 * capability's user-facing promise rests on: a card that already reported a node
 * as done must not be flippable to failed by a later line. A terminal node state
 * is final.
 */
describe('conflicting-node-terminal: VERDICT keep the first terminal', () => {
  it('does not let the later failure overwrite the succeeded node', () => {
    const { final } = replay(fixture('conflicting-node-terminal'));
    expect(final.nodes).toEqual([{ nodeId: 'scan', state: 'succeeded', childRunId: 'child-run-001' }]);
    expect(final.nodes[0].failure).toBeUndefined();
  });

  it('warns and emits nothing for the rejected line', () => {
    const { ctx } = replay(fixture('conflicting-node-terminal'));
    expect(ctx.frames).toHaveLength(2);
    expect(ctx.warns).toHaveLength(1);
    expect(ctx.warns[0]).toContain('already succeeded');
  });
});

// ============================================
// child-duplicate-conflict - VERDICT: reject the second body
// ============================================

/**
 * Same `child_run_id` + `child_sequence` + `event_id`, different `inner.text`.
 * The manifest correlates child events on
 * `child_run_id_and_child_sequence`, so the second copy is claiming a slot that
 * is already filled with different content. Rejecting it means the conflicting
 * copy neither advances the child's correlation state nor counts as new output.
 *
 * Scope note: the child's text itself reaches the renderer through the decoder's
 * own `sub_agent_event` arm, which this capability does not own. The `false`
 * return here is the signal that arm would need in order to forward only what
 * this reducer accepted - wiring that belongs to whoever changes the decoder.
 */
describe('child-duplicate-conflict: VERDICT reject the conflicting child copy', () => {
  it('reports the conflicting copy as not applied', () => {
    const { consumed } = replay(fixture('child-duplicate-conflict'));
    expect(consumed).toEqual([true, true, false]);
  });

  it('warns once and does not re-emit the run', () => {
    const { ctx } = replay(fixture('child-duplicate-conflict'));
    expect(ctx.frames).toHaveLength(2);
    expect(ctx.warns).toHaveLength(1);
    expect(ctx.warns[0]).toContain('different body');
  });

  it('leaves the child correlation state where the first copy left it', () => {
    const { final } = replay(fixture('child-duplicate-conflict'));
    expect(final.children).toEqual([
      { childRunId: 'child-run-001', agentName: 'scan', lastSequence: 0, missingSequences: [], missingTotal: 0 },
    ]);
  });

  /**
   * The child path is not reached through `createDispatcher`, which is what
   * stamps the capability name onto every other message. Without the module
   * re-applying it, this would be the one warning in the operator's log with no
   * owner on it - and the log is the only place a rejected safety event shows up
   * at all.
   */
  it('prefixes its warning with the capability name, exactly as a dispatched warning is', () => {
    const child = replay(fixture('child-duplicate-conflict'));
    expect(child.ctx.warns[0].startsWith(PREFIX), child.ctx.warns[0]).toBe(true);

    const run = replay(fixture('duplicate-conflict'));
    expect(run.ctx.warns[0].startsWith(PREFIX), run.ctx.warns[0]).toBe(true);
  });
});

// ============================================
// child-sequence-gap - VERDICT: apply AND report
// ============================================

/**
 * The child's first observed event is `child_sequence: 1`. Every published
 * example and every fixture starts a child at 0, so sequence 0 - the start of
 * that node's output - never arrived. Same judgement as the run-level gap, for
 * the same reason: no command exists to ask for it back, so the loss is
 * reported rather than used as grounds to discard what did arrive.
 */
describe('child-sequence-gap: VERDICT apply and flag the missing child output', () => {
  it('records the missing child sequence', () => {
    const { final, consumed } = replay(fixture('child-sequence-gap'));
    expect(consumed).toEqual([true, true]);
    expect(final.children).toEqual([
      { childRunId: 'child-run-001', agentName: 'scan', lastSequence: 1, missingSequences: [0], missingTotal: 1 },
    ]);
  });

  it('warns that child output was lost', () => {
    const { ctx } = replay(fixture('child-sequence-gap'));
    expect(ctx.warns).toHaveLength(1);
    expect(ctx.warns[0]).toContain('output lost');
  });
});

// ============================================
// Rules with no fixture of their own
// ============================================

/** Hand-built, and labelled as such - the contract ships no fixture for the rules below. */
const started = {
  type: 'workflow_started',
  workflow_id: 'desktop-audit',
  name: 'Desktop audit',
  node_count: 2,
  run_id: 'run-x',
  event_id: 'ev-0',
  sequence: 0,
};

const nodeEvent = (over: Record<string, unknown>) => ({
  type: 'workflow_node_event',
  run_id: 'run-x',
  node_id: 'scan',
  event_id: 'ev-n',
  sequence: 1,
  state: 'running',
  ...over,
});

const finished = (over: Record<string, unknown> = {}) => ({
  type: 'workflow_finished',
  workflow_id: 'desktop-audit',
  succeeded: true,
  run_id: 'run-x',
  event_id: 'ev-f',
  sequence: 1,
  terminal_state: 'succeeded',
  ...over,
});

const childEvent = (over: Record<string, unknown>) => ({
  type: 'sub_agent_event',
  parent_call_id: 'workflow:scan',
  agent_name: 'scan',
  inner: { type: 'text_delta', msg_id: 'child-msg-001', text: 'scan complete' },
  run_id: 'run-x',
  child_run_id: 'child-run-001',
  child_sequence: 0,
  event_id: 'c-0',
  ...over,
});

/** A capability plus a dispatcher over it, so a test can reach both entry points. */
function harness() {
  const capability = createWorkflowLifecycleCapability();
  return { capability, dispatch: createDispatcher([capability]), ctx: makeContext() };
}

/**
 * These use hand-built events because the contract ships no fixture for them.
 * They are marked as such: each one is a rule the reducer needs in order to keep
 * its fixture-driven promises, not a claim about engine behaviour.
 */
describe('rules the fixtures imply but do not exercise', () => {
  /**
   * A rejected line still occupied a slot on the wire. If the reducer only
   * counted lines it applied, the next legitimate event would look like a gap
   * and produce a warning about a stream that is in fact intact.
   */
  it('counts a rejected line against the sequence so the next one is not a false gap', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(nodeEvent({ event_id: 'ev-1', sequence: 1, state: 'succeeded' }), ctx);
    // Rejected: the node is already terminal.
    dispatch(nodeEvent({ event_id: 'ev-2', sequence: 2, state: 'failed' }), ctx);
    dispatch(nodeEvent({ event_id: 'ev-3', sequence: 3, node_id: 'report', state: 'running' }), ctx);
    expect(ctx.warns.filter((w) => w.includes('jumped from run sequence'))).toEqual([]);
    expect(lastSnapshot(ctx).missingSequences).toEqual([]);
    expect(lastSnapshot(ctx).lastSequence).toBe(3);
  });

  /**
   * A lower sequence under a NEW event_id is not a replay - it is a second,
   * different event claiming a consumed slot, i.e. the same rewrite attack as
   * duplicate-conflict wearing different clothes.
   */
  it('refuses a new event that re-uses an already-consumed sequence', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(nodeEvent({ event_id: 'ev-1', sequence: 2, state: 'running' }), ctx);
    ctx.warns.length = 0;
    ctx.frames.length = 0;
    dispatch(nodeEvent({ event_id: 'ev-2', sequence: 1, node_id: 'report', state: 'running' }), ctx);
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns[0]).toContain('re-uses run sequence 1');
  });

  /**
   * `blocked` is in the state enum but no fixture emits it, and nothing says it
   * is final - a blocked node is waiting on something and may still run. Only
   * succeeded/failed are treated as immovable, so a blocked node must still be
   * able to progress.
   */
  it('lets a blocked node progress, because blocked is not a terminal state', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(nodeEvent({ event_id: 'ev-1', sequence: 1, state: 'blocked' }), ctx);
    dispatch(nodeEvent({ event_id: 'ev-2', sequence: 2, state: 'running' }), ctx);
    expect(lastSnapshot(ctx).nodes).toEqual([{ nodeId: 'scan', state: 'running' }]);
    expect(ctx.warns).toEqual([]);
  });

  /**
   * FAIL-CLOSED: an event for a run we never saw opened is dropped rather than
   * used to synthesise one. A synthesised run has no name and no memory of
   * whether it already finished, so a stale line could resurrect a closed run as
   * a fresh card. The cost - a host attaching mid-stream sees nothing until the
   * next `workflow_started` - is real and is the price of not inventing runs.
   */
  it('drops events for a run it never saw open', () => {
    const { dispatch, ctx } = harness();
    expect(dispatch(nodeEvent({ run_id: 'never-opened' }), ctx)).toBe(true);
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns[0]).toContain('unknown run');
  });

  /**
   * A payload of a type we own that does not satisfy the schema's required
   * fields is not consumed: nothing was decided, so the decoder still gets to
   * report it. Half-reading a safety event into a run is worse than not reading
   * it at all.
   */
  it('refuses malformed payloads of the types it owns', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    expect(dispatch(nodeEvent({ state: 'nonsense' }), ctx)).toBe(false);
    expect(dispatch(nodeEvent({ sequence: '2' }), ctx)).toBe(false);
    // `failure` present but unreadable must not pass as "no failure".
    expect(dispatch(nodeEvent({ state: 'failed', failure: { code: 'x', message: 'y' } }), ctx)).toBe(false);
    expect(ctx.warns.filter((w) => w.includes('malformed'))).toHaveLength(3);
    expect(lastSnapshot(ctx).nodes).toEqual([]);
  });

  /** Key order is an encoder detail; two identical bodies must not read as a conflict. */
  it('treats a replay with reordered keys as identical', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(
      {
        sequence: 0,
        run_id: 'run-x',
        event_id: 'ev-0',
        node_count: 2,
        name: 'Desktop audit',
        workflow_id: 'desktop-audit',
        type: 'workflow_started',
      },
      ctx
    );
    expect(ctx.warns).toEqual([]);
    expect(ctx.frames).toHaveLength(1);
  });

  /** Separate instances must not share a store, or one conversation would see another's runs. */
  it('keeps two instances isolated even on the same run_id', () => {
    const first = createDispatcher([createWorkflowLifecycleCapability()]);
    const second = createDispatcher([createWorkflowLifecycleCapability()]);
    const ctxA = makeContext();
    const ctxB = makeContext();
    first(started, ctxA);
    second({ ...started, name: 'Other audit' }, ctxB);
    expect((ctxA.frames[0].data as WorkflowRunSnapshot).name).toBe('Desktop audit');
    expect((ctxB.frames[0].data as WorkflowRunSnapshot).name).toBe('Other audit');
  });
});

// ============================================
// The immutability promise, on BOTH streams
// ============================================

/**
 * "A closed run is immutable" is the sentence this module is built around, and
 * it is worth exactly as much as its weakest entry point. `applyNodeEvent`
 * enforced it and `observeSubAgentEvent` did not, so a straggler child event
 * could still add output - or a whole new child card - to a run the user had
 * already been told was finished. Both paths are pinned here so the guarantee
 * cannot be half-true again.
 */
describe('a closed run is immutable on every entry point', () => {
  it('refuses a child event that arrives after the run closed', () => {
    const { capability, dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(finished(), ctx);
    const closed = lastSnapshot(ctx);
    ctx.warns.length = 0;
    ctx.frames.length = 0;

    expect(capability.observeSubAgentEvent(childEvent({ event_id: 'c-late' }), ctx)).toBe(false);

    expect(ctx.frames, 'a closed run must not re-emit').toEqual([]);
    expect(ctx.warns[0]).toContain('after run');
    expect(closed.children, 'the delivered projection had no children and still must not').toEqual([]);
  });

  /**
   * The same rule for a child the run already knows about: a run that closes
   * mid-stream freezes the child's correlation state where it stood.
   */
  it('refuses a further event for a child the closed run already tracked', () => {
    const { capability, dispatch, ctx } = harness();
    dispatch(started, ctx);
    capability.observeSubAgentEvent(childEvent({ event_id: 'c-0', child_sequence: 0 }), ctx);
    dispatch(finished({ sequence: 1 }), ctx);
    ctx.warns.length = 0;
    ctx.frames.length = 0;

    expect(capability.observeSubAgentEvent(childEvent({ event_id: 'c-1', child_sequence: 1 }), ctx)).toBe(false);
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns[0]).toContain('after run');
  });

  /**
   * A byte-identical retransmit of a child event that was already applied is
   * still a retransmit after the run closes. It is silent, exactly as it is
   * while the run is live - the terminal check must not turn every reconnect
   * into a contract-violation warning.
   */
  it('stays silent for a byte-identical child replay after the run closed', () => {
    const { capability, dispatch, ctx } = harness();
    dispatch(started, ctx);
    capability.observeSubAgentEvent(childEvent({ event_id: 'c-0' }), ctx);
    dispatch(finished({ sequence: 1 }), ctx);
    ctx.warns.length = 0;

    expect(capability.observeSubAgentEvent(childEvent({ event_id: 'c-0' }), ctx)).toBe(false);
    expect(ctx.warns).toEqual([]);
  });
});

// ============================================
// Guards that had no test of their own
// ============================================

describe('correlation guards, each pinned on its own', () => {
  /**
   * The child mirror of `re-uses run sequence`. `child-duplicate-conflict`
   * cannot reach it: that fixture repeats the `event_id` too, so the ledger
   * answers first and this branch never runs. A SECOND event with a NEW
   * event_id at a consumed child sequence is the case that matters - the
   * published correlation key is `child_run_id_and_child_sequence`, so that
   * slot is spoken for.
   */
  it('refuses a new child event that re-uses an already-consumed child sequence', () => {
    const { capability, dispatch, ctx } = harness();
    dispatch(started, ctx);
    capability.observeSubAgentEvent(childEvent({ event_id: 'c-0', child_sequence: 0 }), ctx);
    capability.observeSubAgentEvent(childEvent({ event_id: 'c-1', child_sequence: 1 }), ctx);
    ctx.warns.length = 0;
    ctx.frames.length = 0;

    const applied = capability.observeSubAgentEvent(
      childEvent({
        event_id: 'c-2',
        child_sequence: 1,
        inner: { type: 'text_delta', msg_id: 'child-msg-002', text: 'a different story' },
      }),
      ctx
    );

    expect(applied).toBe(false);
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns[0]).toContain('re-uses child sequence 1');
  });

  /**
   * A second `workflow_started` for a live run under a DIFFERENT event_id. The
   * ledger cannot answer this one - the key is new - so without its own guard
   * the run record would simply be rebuilt and the card the user is reading
   * would jump to a different name with an empty node list.
   */
  it('refuses a second workflow_started for a run that is already open', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(nodeEvent({ event_id: 'ev-1', sequence: 1, state: 'running' }), ctx);
    ctx.warns.length = 0;
    ctx.frames.length = 0;

    expect(dispatch({ ...started, event_id: 'ev-second', name: 'Second open' }, ctx)).toBe(true);

    expect(ctx.frames, 're-opening must not emit a fresh projection').toEqual([]);
    expect(ctx.warns[0]).toContain('already open');
  });

  /**
   * One run keeps one ledger. Keying it by `event_id` alone made two events of
   * DIFFERENT types that happened to share an id read as one event replayed
   * with a different body - and the later one, a real node transition, was
   * warned about and thrown away. Nothing in the contract says an `event_id` is
   * unique across types, so the key has to carry the type.
   */
  it('does not discard a node event that re-uses the started event id', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(nodeEvent({ event_id: 'ev-0', sequence: 1, state: 'running' }), ctx);

    expect(ctx.warns, `unexpected warnings: ${ctx.warns.join(' | ')}`).toEqual([]);
    expect(lastSnapshot(ctx).nodes).toEqual([{ nodeId: 'scan', state: 'running' }]);
  });

  /** The same id reused by a finish must close the run rather than read as the started's replay. */
  it('does not discard a workflow_finished that re-uses the started event id', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(finished({ event_id: 'ev-0' }), ctx);

    expect(ctx.warns).toEqual([]);
    expect(lastSnapshot(ctx).status).toBe('succeeded');
  });

  /**
   * Rejecting negatives is a host-side choice: the schema types both counters
   * as a bare `integer` with no `minimum`, so `sequence: -3` is schema-valid.
   * It is not harmless - a run opened there leaves the counter negative, and
   * the next legitimate event at 0 enumerates -2 and -1 into `missingSequences`,
   * so the projection reports sequence numbers that cannot exist. Every
   * published example and fixture starts at 0, so refusing costs nothing the
   * contract demonstrates.
   */
  it('refuses a negative run sequence rather than projecting impossible missing numbers', () => {
    const { dispatch, ctx } = harness();
    expect(dispatch({ ...started, run_id: 'run-neg', sequence: -3 }, ctx)).toBe(false);
    expect(ctx.frames, 'a negative-sequence run must never open').toEqual([]);
    expect(ctx.warns.some((w) => w.includes('malformed workflow_started'))).toBe(true);

    // Nothing was opened, so the follow-up has no run to corrupt.
    expect(dispatch(nodeEvent({ run_id: 'run-neg', event_id: 'ev-1', sequence: 0 }), ctx)).toBe(true);
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns.some((w) => w.includes('unknown run'))).toBe(true);
  });

  it('refuses a negative sequence on the other two run types and on the child counter', () => {
    expect(isWorkflowNodeEvent(nodeEvent({ sequence: -1 }))).toBe(false);
    expect(isWorkflowFinished(finished({ sequence: -1 }))).toBe(false);
    expect(isDurableSubAgentEvent(childEvent({ child_sequence: -1 }))).toBe(false);
    // ... while 0, the value every example uses, still passes.
    expect(isWorkflowNodeEvent(nodeEvent({ sequence: 0 }))).toBe(true);
    expect(isWorkflowFinished(finished({ sequence: 0 }))).toBe(true);
    expect(isDurableSubAgentEvent(childEvent({ child_sequence: 0 }))).toBe(true);
  });
});

// ============================================
// The projection's optional fields
// ============================================

/**
 * `failure` and `parentRunId` are the fields a user actually reads when
 * something went wrong, and they are the easiest to lose: they are assigned
 * behind `!== undefined` checks that nothing else depends on, so deleting any
 * one of those lines changes no control flow. Each is pinned here against the
 * value the wire carried.
 */
describe('the projection carries the fields a failure is described by', () => {
  const failure = { code: 'stage_failed', message: 'scan blew up', retryable: false };

  it('carries a failed node failure detail through to the snapshot', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(nodeEvent({ event_id: 'ev-1', sequence: 1, state: 'failed', failure }), ctx);
    expect(lastSnapshot(ctx).nodes).toEqual([{ nodeId: 'scan', state: 'failed', failure }]);
  });

  it('carries a failed run failure detail through to the snapshot', () => {
    const { dispatch, ctx } = harness();
    const runFailure = { code: 'workflow_aborted', message: 'operator cancelled', retryable: true };
    dispatch(started, ctx);
    dispatch(finished({ succeeded: false, terminal_state: 'failed', failure: runFailure }), ctx);
    const final = lastSnapshot(ctx);
    expect(final.status).toBe('failed');
    expect(final.failure).toEqual(runFailure);
  });

  it('projects parent_run_id for a run another run spawned', () => {
    const { dispatch, ctx } = harness();
    dispatch({ ...started, parent_run_id: 'parent-run-9' }, ctx);
    expect(lastSnapshot(ctx).parentRunId).toBe('parent-run-9');
  });

  /** Absent means absent: a snapshot must not carry `parentRunId: undefined` for a root run. */
  it('omits parentRunId entirely when the run has no parent', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    expect('parentRunId' in lastSnapshot(ctx)).toBe(false);
    expect('failure' in lastSnapshot(ctx)).toBe(false);
  });

  /**
   * `child_run_id` is optional on a node event. Once a node has been joined to
   * its sub-agent run, a later transition that omits the field must not unjoin
   * it - the child's output is still that node's work.
   */
  it('keeps a node joined to its child run when a later transition omits the id', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(nodeEvent({ event_id: 'ev-1', sequence: 1, state: 'running', child_run_id: 'child-run-001' }), ctx);
    dispatch(nodeEvent({ event_id: 'ev-2', sequence: 2, state: 'succeeded' }), ctx);
    expect(lastSnapshot(ctx).nodes).toEqual([{ nodeId: 'scan', state: 'succeeded', childRunId: 'child-run-001' }]);
  });
});

// ============================================
// workflow_finished contradicting itself
// ============================================

/**
 * `succeeded` and `terminal_state` are both required and could disagree. The
 * contract does not say which wins, so the disagreement is reported and the
 * pessimistic reading taken: claiming success on self-contradicting evidence is
 * the failure that costs the user something.
 *
 * THE DIRECTION MATTERS. `succeeded: true` + `terminal_state: 'failed'` proves
 * nothing - a naive reducer that simply trusts `terminal_state` produces
 * `failed` there too. Only `succeeded: false` + `terminal_state: 'succeeded'`
 * separates the two readings, so that is the case that carries the rule.
 */
describe('workflow_finished that contradicts itself', () => {
  it('reports failed when terminal_state says succeeded and succeeded says otherwise', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(finished({ succeeded: false, terminal_state: 'succeeded' }), ctx);
    // A reducer that trusted terminal_state would say 'succeeded' here.
    expect(lastSnapshot(ctx).status).toBe('failed');
    expect(ctx.warns.some((w) => w.includes('contradicts itself'))).toBe(true);
  });

  it('reports failed in the other direction too', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(finished({ succeeded: true, terminal_state: 'failed' }), ctx);
    expect(lastSnapshot(ctx).status).toBe('failed');
    expect(ctx.warns.some((w) => w.includes('contradicts itself'))).toBe(true);
  });

  /** An agreeing pair must close the run on its own word and say nothing. */
  it('stays quiet and takes terminal_state when the two agree', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(finished({ succeeded: false, terminal_state: 'failed' }), ctx);
    expect(lastSnapshot(ctx).status).toBe('failed');
    expect(ctx.warns).toEqual([]);
  });
});

// ============================================
// The module's own bounds
// ============================================

/**
 * Three ceilings this module imposes on itself, none of them in the contract.
 * They are the difference between a reducer and a resource the wire controls,
 * so each is exercised at its edge rather than trusted because it is written
 * down.
 */
describe('self-imposed bounds', () => {
  /**
   * THE ATTACK. `sequence` is engine-controlled and the schema puts no ceiling
   * on it. Filling a gap by enumerating every missing number means one frame
   * decides how long the synchronous decode path runs and how large a `Set`
   * grows - `sequence: 9007199254740991` is a hang plus an out-of-memory from a
   * single well-formed line.
   *
   * The cap enumerates the FIRST `MAX_ENUMERATED_MISSING` gap members and stops;
   * `missingTotal` keeps the true size by arithmetic, so the projection
   * under-lists the loss without under-reporting it, and the event itself is
   * still applied.
   */
  it('caps the gap it enumerates when a node event jumps far ahead', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(nodeEvent({ event_id: 'ev-far', sequence: 100_000, state: 'running' }), ctx);

    const final = lastSnapshot(ctx);
    expect(final.missingSequences).toHaveLength(MAX_ENUMERATED_MISSING);
    expect(final.missingSequences[0]).toBe(1);
    expect(final.missingSequences[MAX_ENUMERATED_MISSING - 1]).toBe(MAX_ENUMERATED_MISSING);
    expect(final.missingTotal, 'the count must stay exact even though the list is capped').toBe(99_999);
    expect(final.nodes).toEqual([{ nodeId: 'scan', state: 'running' }]);
  });

  /** Same cap on the other run-level site: a run whose first line is already far along. */
  it('caps the gap it enumerates when a run opens far from zero', () => {
    const { dispatch, ctx } = harness();
    dispatch({ ...started, sequence: 100_000 }, ctx);

    const final = lastSnapshot(ctx);
    expect(final.missingSequences).toHaveLength(MAX_ENUMERATED_MISSING);
    expect(final.missingSequences[0]).toBe(0);
    expect(final.missingTotal).toBe(100_000);
  });

  /** And on both child sites, which have their own counter and their own set. */
  it('caps the gap it enumerates for a child, on first sight and on a later jump', () => {
    const { capability, dispatch, ctx } = harness();
    dispatch(started, ctx);

    capability.observeSubAgentEvent(childEvent({ event_id: 'c-far', child_sequence: 100_000 }), ctx);
    const firstSight = lastSnapshot(ctx).children[0];
    expect(firstSight.missingSequences).toHaveLength(MAX_ENUMERATED_MISSING);
    expect(firstSight.missingTotal).toBe(100_000);

    capability.observeSubAgentEvent(
      childEvent({ event_id: 'c-farther', child_sequence: 300_000, child_run_id: 'child-run-001' }),
      ctx
    );
    const afterJump = lastSnapshot(ctx).children[0];
    expect(afterJump.missingSequences, 'already at the cap, so the second gap adds nothing to the list').toHaveLength(
      MAX_ENUMERATED_MISSING
    );
    expect(afterJump.missingTotal, 'but it is still counted in full').toBe(100_000 + 199_999);
    expect(afterJump.lastSequence).toBe(300_000);
  });

  /**
   * The shape of the actual attack, at the largest value the wire can express.
   * With the cap in place this returns in microseconds; without it, this line
   * does not fail - it hangs the process, which is the finding. The bounded
   * cases above are the ones that go red on a plain assertion.
   */
  it('survives a sequence at the integer ceiling', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    dispatch(nodeEvent({ event_id: 'ev-max', sequence: Number.MAX_SAFE_INTEGER, state: 'running' }), ctx);

    const final = lastSnapshot(ctx);
    expect(final.missingSequences).toHaveLength(MAX_ENUMERATED_MISSING);
    expect(final.missingTotal).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(final.lastSequence).toBe(Number.MAX_SAFE_INTEGER);
  });

  /**
   * The run map has a ceiling because nothing in the contract bounds how many
   * runs a session opens, and this process lives as long as the conversation.
   * A FINISHED run is given up first: its projection has already been
   * delivered, so losing it costs an update nobody is waiting for.
   */
  it('evicts a finished run before a live one when the run ceiling is reached', () => {
    const { dispatch, ctx } = harness();
    // run-0 opens and closes; run-1..run-(MAX-1) stay live. That is MAX runs.
    dispatch({ ...started, run_id: 'run-0', event_id: 'e-0' }, ctx);
    dispatch(finished({ run_id: 'run-0', event_id: 'f-0' }), ctx);
    for (let i = 1; i < MAX_TRACKED_RUNS; i += 1) {
      dispatch({ ...started, run_id: `run-${i}`, event_id: `e-${i}` }, ctx);
    }
    ctx.warns.length = 0;

    dispatch({ ...started, run_id: 'run-overflow', event_id: 'e-overflow' }, ctx);
    expect(ctx.warns, 'giving up a finished run is not worth an operator warning').toEqual([]);

    // run-0 is gone: an event for it is now an event for an unknown run.
    dispatch(nodeEvent({ run_id: 'run-0', event_id: 'n-0', sequence: 2 }), ctx);
    expect(ctx.warns.some((w) => w.includes('unknown run "run-0"'))).toBe(true);
    // A live run opened at the same time is still tracked.
    dispatch(nodeEvent({ run_id: 'run-1', event_id: 'n-1', sequence: 1 }), ctx);
    expect(lastSnapshot(ctx).runId).toBe('run-1');
  });

  /**
   * When every tracked run is still live there is no cheap victim, so the
   * oldest goes and the operator is told - dropping a live run loses updates a
   * card is still showing. The warning must name the run it took; naming
   * `undefined` would make the log useless exactly when it matters.
   */
  it('warns by name when it has to evict a run that is still running', () => {
    const { dispatch, ctx } = harness();
    for (let i = 0; i < MAX_TRACKED_RUNS; i += 1) {
      dispatch({ ...started, run_id: `live-${i}`, event_id: `e-${i}` }, ctx);
    }
    ctx.warns.length = 0;

    dispatch({ ...started, run_id: 'live-overflow', event_id: 'e-overflow' }, ctx);
    expect(ctx.warns).toHaveLength(1);
    expect(ctx.warns[0]).toContain('still running');
    expect(ctx.warns[0]).toContain('"live-0"');
    expect(ctx.warns[0]).not.toContain('undefined');
  });

  /**
   * The idempotency ledger is bounded too, and the consequence is deliberate:
   * beyond the window a replay is no longer recognised as one. It cannot do
   * damage - the re-open, terminal-node and closed-run rules do not consult the
   * ledger - but it does become visible, and that visible difference is what
   * proves the bound is real rather than written down.
   */
  it('forgets the oldest ledger entry once the window is full', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    // Enough distinct events to push the started entry out of the window.
    for (let i = 1; i <= MAX_LEDGER_ENTRIES; i += 1) {
      dispatch(nodeEvent({ event_id: `n-${i}`, sequence: i, state: i % 2 === 0 ? 'running' : 'queued' }), ctx);
    }
    ctx.warns.length = 0;
    ctx.frames.length = 0;

    // Byte-identical to the opening line. Inside the window this is a silent
    // replay; outside it, the re-open guard is what answers instead.
    dispatch(started, ctx);
    expect(ctx.frames, 'the re-open guard still refuses to rebuild the run').toEqual([]);
    expect(ctx.warns[0]).toContain('already open');
  });

  /** Inside the window the same replay is still silent - the bound must not fire early. */
  it('still recognises a replay while the window has room', () => {
    const { dispatch, ctx } = harness();
    dispatch(started, ctx);
    for (let i = 1; i < MAX_LEDGER_ENTRIES - 1; i += 1) {
      dispatch(nodeEvent({ event_id: `n-${i}`, sequence: i, state: i % 2 === 0 ? 'running' : 'queued' }), ctx);
    }
    ctx.warns.length = 0;
    ctx.frames.length = 0;

    dispatch(started, ctx);
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns).toEqual([]);
  });
});
