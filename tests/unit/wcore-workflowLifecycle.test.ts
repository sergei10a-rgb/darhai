/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `workflow_lifecycle_v1` - the reducer, driven by the engine's own fixtures.
 *
 * Every case below replays a real file from
 * `tests/fixtures/engine-contract/desktop/v1/adversarial/workflow/` line by
 * line, in order, through the SAME `createDispatcher` production calls. Nothing
 * here is a hand-written approximation of what the engine sends.
 *
 * A note on verdicts. The contract publishes correlation keys and a criticality
 * grade; it does NOT publish "accept this fixture, reject that one", and
 * `tests/helpers/engineContract.ts` warns in its own header that fixture names
 * are not an oracle - `duplicate-identical` is a case a host should TOLERATE.
 * So each block below states its verdict and argues it from the manifest, the
 * schema, or the fixture body. Where two readings were defensible (the sequence
 * gap) the block says so rather than dressing a judgement call up as a rule.
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
  WORKFLOW_RUN_FRAME,
} from '@process/agent/wcore/capabilities/workflowLifecycle';
import type { WorkflowRunSnapshot } from '@process/agent/wcore/capabilities/workflowLifecycle';
import { adversarialFixtures, examplePayload, readFixture, surfaceOf, validateEvent } from '../helpers/engineContract';

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

type Replay = {
  ctx: Recorder;
  /** Per line: did the host consume it? */
  consumed: boolean[];
  snapshots: WorkflowRunSnapshot[];
  final: WorkflowRunSnapshot;
};

/**
 * Replay a fixture exactly as the running host would.
 *
 * `sub_agent_event` is routed to `observeSubAgentEvent` rather than through the
 * dispatcher because that is what production does: the decoder has a first-class
 * `sub_agent_event` switch arm, so the type never reaches the capability
 * dispatcher at all. `declines the child event type at the dispatcher` below
 * pins that split so this helper cannot quietly diverge from the real routing.
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
 *     information, and `manifest.commands` for this capability is EMPTY, so a
 *     host has no verb with which to request the missing range. Dropping would
 *     freeze the card with no path back.
 *   drop-until-resynced - refuses to show state derived from an incomplete
 *     stream.
 *
 * The two produce visibly different UI, so the gap is carried in
 * `missingSequences` rather than being swallowed either way.
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
 * return here is the signal that arm needs in order to forward only what this
 * reducer accepted - wiring that belongs to whoever removes the duplicate
 * forwarding, not to this module.
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
      { childRunId: 'child-run-001', agentName: 'scan', lastSequence: 0, missingSequences: [] },
    ]);
  });
});

// ============================================
// child-sequence-gap - VERDICT: apply AND report
// ============================================

/**
 * The child's first observed event is `child_sequence: 1`. The counter starts at
 * 0, so sequence 0 - the start of that node's output - never arrived. Same
 * judgement as the run-level gap, for the same reason: no command exists to ask
 * for it back, so the loss is reported rather than used as grounds to discard
 * what did arrive.
 */
describe('child-sequence-gap: VERDICT apply and flag the missing child output', () => {
  it('records the missing child sequence', () => {
    const { final, consumed } = replay(fixture('child-sequence-gap'));
    expect(consumed).toEqual([true, true]);
    expect(final.children).toEqual([
      { childRunId: 'child-run-001', agentName: 'scan', lastSequence: 1, missingSequences: [0] },
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
    const dispatch = createDispatcher([createWorkflowLifecycleCapability()]);
    const ctx = makeContext();
    dispatch(started, ctx);
    dispatch(nodeEvent({ event_id: 'ev-1', sequence: 1, state: 'succeeded' }), ctx);
    // Rejected: the node is already terminal.
    dispatch(nodeEvent({ event_id: 'ev-2', sequence: 2, state: 'failed' }), ctx);
    dispatch(nodeEvent({ event_id: 'ev-3', sequence: 3, node_id: 'report', state: 'running' }), ctx);
    expect(ctx.warns.filter((w) => w.includes('jumped from run sequence'))).toEqual([]);
    const final = ctx.frames[ctx.frames.length - 1].data as WorkflowRunSnapshot;
    expect(final.missingSequences).toEqual([]);
    expect(final.lastSequence).toBe(3);
  });

  /**
   * A lower sequence under a NEW event_id is not a replay - it is a second,
   * different event claiming a consumed slot, i.e. the same rewrite attack as
   * duplicate-conflict wearing different clothes.
   */
  it('refuses a new event that re-uses an already-consumed sequence', () => {
    const dispatch = createDispatcher([createWorkflowLifecycleCapability()]);
    const ctx = makeContext();
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
    const dispatch = createDispatcher([createWorkflowLifecycleCapability()]);
    const ctx = makeContext();
    dispatch(started, ctx);
    dispatch(nodeEvent({ event_id: 'ev-1', sequence: 1, state: 'blocked' }), ctx);
    dispatch(nodeEvent({ event_id: 'ev-2', sequence: 2, state: 'running' }), ctx);
    const final = ctx.frames[ctx.frames.length - 1].data as WorkflowRunSnapshot;
    expect(final.nodes).toEqual([{ nodeId: 'scan', state: 'running' }]);
    expect(ctx.warns).toEqual([]);
  });

  /**
   * `succeeded` and `terminal_state` are both required and could disagree. The
   * contract does not say which wins, so the disagreement is reported and the
   * pessimistic reading taken: claiming success on self-contradicting evidence
   * is the failure that costs the user something.
   */
  it('reports a self-contradicting workflow_finished as failed', () => {
    const dispatch = createDispatcher([createWorkflowLifecycleCapability()]);
    const ctx = makeContext();
    dispatch(started, ctx);
    dispatch(
      {
        type: 'workflow_finished',
        workflow_id: 'desktop-audit',
        succeeded: true,
        run_id: 'run-x',
        event_id: 'ev-f',
        sequence: 1,
        terminal_state: 'failed',
      },
      ctx
    );
    const final = ctx.frames[ctx.frames.length - 1].data as WorkflowRunSnapshot;
    expect(final.status).toBe('failed');
    expect(ctx.warns[0]).toContain('contradicts itself');
  });

  /**
   * FAIL-CLOSED: an event for a run we never saw opened is dropped rather than
   * used to synthesise one. A synthesised run has no name and no memory of
   * whether it already finished, so a stale line could resurrect a closed run as
   * a fresh card. The cost - a host attaching mid-stream sees nothing until the
   * next `workflow_started` - is real and is the price of not inventing runs.
   */
  it('drops events for a run it never saw open', () => {
    const dispatch = createDispatcher([createWorkflowLifecycleCapability()]);
    const ctx = makeContext();
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
    const dispatch = createDispatcher([createWorkflowLifecycleCapability()]);
    const ctx = makeContext();
    dispatch(started, ctx);
    expect(dispatch(nodeEvent({ state: 'nonsense' }), ctx)).toBe(false);
    expect(dispatch(nodeEvent({ sequence: '2' }), ctx)).toBe(false);
    // `failure` present but unreadable must not pass as "no failure".
    expect(dispatch(nodeEvent({ state: 'failed', failure: { code: 'x', message: 'y' } }), ctx)).toBe(false);
    expect(ctx.warns.filter((w) => w.includes('malformed'))).toHaveLength(3);
    const final = ctx.frames[ctx.frames.length - 1].data as WorkflowRunSnapshot;
    expect(final.nodes).toEqual([]);
  });

  /** Key order is an encoder detail; two identical bodies must not read as a conflict. */
  it('treats a replay with reordered keys as identical', () => {
    const dispatch = createDispatcher([createWorkflowLifecycleCapability()]);
    const ctx = makeContext();
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
