/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The engine's execution-policy receipts, driven through the real fixtures.
 *
 * `execution_policy` is the ONLY event the v1 manifest grades
 * `criticality: "safety"` and the only one whose schema pins `critical` to
 * `const: true`. It tells the host what posture the engine is actually
 * enforcing. Six adversarial fixtures exist for it, and they declare INPUT
 * only - nothing in the bundle states the verdict a host owes each one. So each
 * test below states the verdict AND the evidence it rests on: the manifest's
 * `criticality`/`correlation` grading, the JSON Schema, or the shape of the
 * fixture itself. The filename is never the justification -
 * `duplicate-identical` is a case a host should TOLERATE, and `noncritical`
 * names a flag, not a verdict.
 *
 * Routing goes through `createDispatcher`, the same function production builds
 * its dispatcher from, over a handler list this file supplies. It has to supply
 * one - and, more to the point, its own capability INSTANCE: there is no module
 * singleton to import, because the revision tracker is per-engine state and
 * Darhai runs one engine per open conversation. What these tests prove is the
 * reducer and the handler; that the capability is reached in the running app is
 * `createCapabilitySet()`, pinned by `wcore-readySeed.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { createDispatcher } from '@process/agent/wcore/capabilities';
import type { CapabilityContext } from '@process/agent/wcore/capabilities/types';
import {
  createExecutionPolicyCapability,
  EXECUTION_POLICY_SUBCONTRACT_VERSION,
  PolicyRevisionTracker,
} from '@process/agent/wcore/capabilities/handlers/executionPolicy';
import type {
  ExecutionPolicyCapability,
  ExecutionPolicyFrame,
  PolicyVerdict,
} from '@process/agent/wcore/capabilities/handlers/executionPolicy';
import {
  adversarialFixtures,
  entryFor,
  examplePayload,
  readFixture,
  readManifest,
  surfaceOf,
  validateEvent,
} from '../helpers/engineContract';

const CAPABILITY = 'effective_execution_policy_revisions';

type Recorder = CapabilityContext & {
  frames: { type: string; data: ExecutionPolicyFrame; msg_id: string }[];
  logs: string[];
  warns: string[];
};

function makeContext(): Recorder {
  const frames: Recorder['frames'] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    frames,
    logs,
    warns,
    sendCommand: () => {
      throw new Error('this capability has no commands - the manifest lists none');
    },
    emit: (f) => frames.push(f as Recorder['frames'][number]),
    activeMsgId: () => 'msg-1',
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  };
}

/**
 * What one replayed message produced.
 *
 * `silent` is not a verdict the reducer can return - it is what the REPLAY saw:
 * the dispatcher consumed the message and the handler announced nothing. It has
 * to be distinguishable, because the handler stays deliberately quiet on an
 * `idempotent` receipt, and a replay that simply re-read the newest frame after
 * every dispatch would credit that silence to the PREVIOUS message's verdict
 * and report a sequence that never happened.
 */
type ReplayVerdict = PolicyVerdict | 'silent';

type Replayed = { ctx: Recorder; cap: ExecutionPolicyCapability; verdicts: ReplayVerdict[] };

/**
 * Replay a message sequence exactly as the decoder would.
 *
 * `ready` is not dispatched: it has its own arm in the decoder, so its embedded
 * revision-0 receipt enters through `seedFromReady` and its verdict is read
 * from the returned decision. Every other line goes through the real
 * dispatcher, and its verdict is read from the frame THAT dispatch emitted -
 * never from whatever frame happened to be last.
 */
function replayMessages(messages: Record<string, unknown>[], label: string): Replayed {
  const cap = createExecutionPolicyCapability();
  const dispatch = createDispatcher([cap]);
  const ctx = makeContext();
  const verdicts: ReplayVerdict[] = [];

  for (const message of messages) {
    if (message.type === 'ready') {
      const decision = cap.seedFromReady(message, ctx);
      if (decision) verdicts.push(decision.verdict);
      continue;
    }
    const before = ctx.frames.length;
    expect(dispatch(message, ctx), `${label}: dispatcher did not consume ${String(message.type)}`).toBe(true);
    const emitted = ctx.frames.slice(before);
    verdicts.push(emitted.length > 0 ? emitted[emitted.length - 1].data.verdict : 'silent');
  }

  return { ctx, cap, verdicts };
}

function replay(relPath: string): Replayed {
  return replayMessages(readFixture(relPath), relPath);
}

/**
 * An unmodelled sub-object `levels` deep, for the depth-bound tests below.
 *
 * The comparison in the reducer recurses, so it is bounded, and that bound is a
 * CHOICE the module documents rather than a number the contract states -
 * nothing in the bundle limits nesting. The arithmetic: the receipt body sits
 * at depth 0 and `policy` at depth 1, so a chain of N objects hung under
 * `policy` reaches depth 1 + N; with the cap at 8, six levels are compared and
 * seven are refused. Both sides of that line are pinned so it cannot move by
 * accident.
 */
const nest = (levels: number): unknown => (levels === 0 ? 'leaf' : { deeper: nest(levels - 1) });

/**
 * A hand-built receipt, used where a fixture cannot reach the rule under test.
 * Revision 4 rather than 0 so "behind" and "ahead" both have room.
 */
const seed = {
  type: 'execution_policy',
  critical: true,
  contract_version: '1.0',
  revision: 4,
  reason: 'launch',
  effective_at_unix_ms: 1_721_000_000_000,
  policy: {
    posture: 'smart',
    approvals: 'prompt',
    sandbox: 'required',
    source: 'desktop_local_launch',
    managed_floor_active: false,
  },
} as const;

describe('the contract surface this capability owns', () => {
  it('claims every event the manifest files under it, and nothing it does not own', () => {
    const surface = surfaceOf(CAPABILITY);
    expect(surface.events.map((e) => e.type)).toEqual(['execution_policy']);
    // No commands: this capability is receive-only, which is why a host cannot
    // ask the engine to re-send a revision it missed. That constraint is what
    // makes the gap rule's cost permanent for the session.
    expect(surface.commands).toEqual([]);
    expect(createExecutionPolicyCapability().handles).toContain('execution_policy');
  });

  /**
   * The two manifest fields the reducer's rules are argued from. If an engine
   * bump downgrades `criticality` or moves `correlation` off `revision`, the
   * justification for rejecting a gap or a conflict evaporates and these rules
   * must be re-derived rather than inherited.
   */
  it('is still graded safety-class and still correlated on revision', () => {
    const entry = entryFor('event', 'execution_policy');
    expect(entry?.criticality).toBe('safety');
    expect(entry?.correlation).toBe('revision');
  });

  it('validates receipts against the subcontract version the manifest publishes', () => {
    expect(readManifest().subcontracts.execution_policy).toBe(EXECUTION_POLICY_SUBCONTRACT_VERSION);
  });

  /**
   * `workspace_policy` is claimed but is NOT in the manifest - the running
   * engine emits it while the bundle declares no payload for it anywhere.
   * Pinning that here means the day it gains a schema, this assertion fails and
   * someone models the body instead of leaving the tag-only handler in place.
   */
  it('claims workspace_policy even though the contract still declares no payload for it', () => {
    expect(createExecutionPolicyCapability().handles).toContain('workspace_policy');
    expect(readManifest().events.some((e) => e.type === 'workspace_policy')).toBe(false);
  });
});

describe('adversarial/policy fixtures', () => {
  /**
   * valid-revisions: `ready` seeds revision 0 (`approvals: prompt`,
   * `source: desktop_local_launch`), then revision 1 arrives with
   * `approvals: auto_edit`, `source: protocol`, `reason: mode_change`.
   * Exactly `previous + 1` on the manifest's correlation key, `critical: true`,
   * `contract_version: 1.0` - there is nothing left for a host to object to.
   */
  it('valid-revisions: applies revision 1 and adopts the new posture', () => {
    const { ctx, cap, verdicts } = replay('adversarial/policy/valid-revisions.jsonl');

    expect(verdicts).toEqual(['applied', 'applied']);
    expect(cap.tracker.revision).toBe(1);
    expect(cap.tracker.current?.approvals).toBe('auto_edit');
    expect(cap.tracker.current?.source).toBe('protocol');
    expect(cap.tracker.stale).toBe(false);
    expect(ctx.warns).toEqual([]);

    const frame = ctx.frames.at(-1);
    expect(frame?.type).toBe('execution_policy');
    // Session-scoped fact: it must not be filed under whatever turn is open.
    expect(frame?.msg_id).toBe('');
    expect(frame?.data.announcedReason).toBe('mode_change');
    expect(frame?.data.stale).toBe(false);
  });

  /**
   * revision-gap: revision jumps 0 -> 2. `revision` is this event's declared
   * correlation key, so a jump means at least one safety-class receipt never
   * arrived and the host cannot know what it said. Rejecting keeps the last
   * VERIFIED posture (`prompt`) rather than adopting `auto_edit` on a chain
   * with a hole in it - and marks the picture stale so the divergence is
   * visible instead of silent.
   */
  it('revision-gap: refuses revision 2 after 0 and keeps the last verified posture', () => {
    const { ctx, cap, verdicts } = replay('adversarial/policy/revision-gap.jsonl');

    expect(verdicts).toEqual(['applied', 'gap']);
    expect(cap.tracker.revision).toBe(0);
    expect(cap.tracker.current?.approvals).toBe('prompt');
    expect(cap.tracker.current?.source).toBe('desktop_local_launch');
    expect(cap.tracker.stale).toBe(true);
    expect(ctx.warns.join(' ')).toContain('gap');

    const frame = ctx.frames.at(-1);
    expect(frame?.data.announcedRevision).toBe(2);
    expect(frame?.data.appliedRevision).toBe(0);
    expect(frame?.data.policy?.approvals).toBe('prompt');
    expect(frame?.data.stale).toBe(true);
  });

  /**
   * duplicate-conflict: two receipts both claim revision 0, one with
   * `approvals: prompt / reason: launch`, the other with
   * `approvals: auto_edit / reason: mode_change`. Revision is the correlation
   * key, so two bodies under one revision is a contradiction, not a
   * last-write-wins update. Last-write-wins is exactly the wrong default here:
   * it would let a single frame walk the host from `prompt` to `auto_edit`
   * while claiming to be the receipt it already holds.
   */
  it('duplicate-conflict: refuses a second body under revision 0', () => {
    const { ctx, cap, verdicts } = replay('adversarial/policy/duplicate-conflict.jsonl');

    expect(verdicts).toEqual(['applied', 'conflict']);
    expect(cap.tracker.revision).toBe(0);
    expect(cap.tracker.current?.approvals).toBe('prompt');
    expect(cap.tracker.stale).toBe(true);
    expect(ctx.warns.join(' ')).toContain('conflict');
  });

  /**
   * duplicate-identical: two BYTE-IDENTICAL `ready` frames - note this fixture
   * contains no standalone `execution_policy` at all, so what it really proves
   * is that a replayed revision-0 receipt is benign. A host that treated it as
   * a conflict would cry wolf on every reconnect and train the operator to
   * ignore the one event that matters. Tolerated: no state change, no warning,
   * and `stale` stays false.
   */
  it('duplicate-identical: tolerates an exact replay without warning or state change', () => {
    const { ctx, cap, verdicts } = replay('adversarial/policy/duplicate-identical.jsonl');

    expect(verdicts).toEqual(['applied', 'idempotent']);
    expect(cap.tracker.revision).toBe(0);
    expect(cap.tracker.current?.approvals).toBe('prompt');
    expect(cap.tracker.stale).toBe(false);
    expect(ctx.warns).toEqual([]);
    // One frame, from the seed - a replay that changes nothing announces nothing.
    expect(ctx.frames).toHaveLength(1);
  });

  /**
   * noncritical: `critical: false` on a field the schema pins to `const: true`.
   * The schema itself refuses this payload (asserted below), so a frame that
   * disclaims criticality while carrying the only safety-class posture receipt
   * is either a shape this host has never been told about or an attempt to
   * downgrade one it has. Either way it is not something to act on.
   */
  it('noncritical: refuses a receipt that disclaims the criticality the schema pins', () => {
    const { ctx, cap, verdicts } = replay('adversarial/policy/noncritical.jsonl');

    expect(verdicts).toEqual(['applied', 'not_critical']);
    expect(cap.tracker.revision).toBe(0);
    expect(cap.tracker.current?.approvals).toBe('prompt');
    expect(cap.tracker.stale).toBe(true);
    expect(ctx.warns.join(' ')).toContain('not_critical');
  });

  /**
   * version-mismatch: `contract_version: "2.0"` against
   * `manifest.subcontracts.execution_policy === "1.0"`. A MAJOR bump may
   * redefine what `approvals` or `sandbox` mean, and adopting a posture this
   * host may be misreading is the precise risk the event exists to remove.
   * Note the JSON Schema cannot catch this (asserted below) - `contract_version`
   * is just `type: string` there. Only the manifest settles it.
   */
  it('version-mismatch: refuses a receipt from a subcontract major it does not implement', () => {
    const { ctx, cap, verdicts } = replay('adversarial/policy/version-mismatch.jsonl');

    expect(verdicts).toEqual(['applied', 'version_mismatch']);
    expect(cap.tracker.revision).toBe(0);
    expect(cap.tracker.current?.approvals).toBe('prompt');
    expect(cap.tracker.stale).toBe(true);
    expect(ctx.warns.join(' ')).toContain('version_mismatch');
  });

  /**
   * The inventory guard. A future engine bump that ships a seventh policy
   * fixture must break the build rather than sail past untested - which is what
   * "we drove the fixtures" would otherwise quietly stop meaning.
   */
  it('every fixture the bundle ships has a case above', () => {
    const covered = [
      'adversarial/policy/duplicate-conflict.jsonl',
      'adversarial/policy/duplicate-identical.jsonl',
      'adversarial/policy/noncritical.jsonl',
      'adversarial/policy/revision-gap.jsonl',
      'adversarial/policy/valid-revisions.jsonl',
      'adversarial/policy/version-mismatch.jsonl',
    ];
    expect(adversarialFixtures('policy')).toEqual(covered);
    expect(readManifest().fixture_inventory.filter((p) => p.startsWith('adversarial/policy/'))).toEqual(covered);
  });
});

/**
 * The replay helper is test infrastructure, and it was wrong in a way that
 * would have made a real regression look green, so it gets its own check.
 */
describe('the replay helper attributes verdicts to the message that caused them', () => {
  /**
   * No shipped fixture reaches this: all six either dispatch nothing (both
   * `duplicate-identical` lines are `ready`) or dispatch something that
   * announces a frame. So the sequence is built by hand - `ready` seeding
   * revision 0, then the SAME receipt re-announced standalone, which the
   * handler grades `idempotent` and deliberately keeps quiet about.
   *
   * A helper that read the newest frame after each dispatch would report
   * `['applied', 'applied']` here - the seed's own verdict, credited to a
   * message that produced nothing. Every fixture expectation in this file is
   * only worth what this test proves.
   */
  it('reports a dispatch that announced nothing as silent, not as the previous verdict', () => {
    const ready = examplePayload('event', 'ready');
    const receipt = ready.execution_policy as Record<string, unknown>;

    const { ctx, cap, verdicts } = replayMessages(
      [ready, { type: 'execution_policy', ...receipt }],
      'hand-built ready + identical standalone'
    );

    expect(verdicts).toEqual(['applied', 'silent']);
    expect(ctx.frames).toHaveLength(1);
    expect(cap.tracker.revision).toBe(0);
    expect(cap.tracker.stale).toBe(false);
  });

  it('still reports a dispatch that did announce a frame with that frame’s verdict', () => {
    const ready = examplePayload('event', 'ready');
    const receipt = ready.execution_policy as Record<string, unknown>;

    const { verdicts } = replayMessages(
      [ready, { type: 'execution_policy', ...receipt, revision: 7 }],
      'hand-built ready + gap'
    );

    expect(verdicts).toEqual(['applied', 'gap']);
  });
});

/**
 * Which fixtures the published schema can catch on its own, and which need the
 * reducer. This is the honest boundary of "validate against the contract": four
 * of the six adversarial payloads are perfectly valid JSON Schema instances, so
 * a host that only validates would accept every one of them.
 */
describe('what schema validation alone settles', () => {
  const standaloneOf = (relPath: string): Record<string, unknown> => {
    const frame = readFixture(relPath).find((m) => m.type === 'execution_policy');
    expect(frame, `${relPath} has no standalone execution_policy line`).toBeDefined();
    return frame as Record<string, unknown>;
  };

  it('accepts the engine’s own example payload', () => {
    expect(validateEvent(examplePayload('event', 'execution_policy')).valid).toBe(true);
  });

  it('rejects only the noncritical fixture - `critical` is the one field it pins', () => {
    expect(validateEvent(standaloneOf('adversarial/policy/noncritical.jsonl')).valid).toBe(false);
  });

  it('accepts the gap, conflict and version-mismatch payloads, so only the reducer catches them', () => {
    for (const path of [
      'adversarial/policy/revision-gap.jsonl',
      'adversarial/policy/duplicate-conflict.jsonl',
      'adversarial/policy/version-mismatch.jsonl',
      'adversarial/policy/valid-revisions.jsonl',
    ]) {
      expect(validateEvent(standaloneOf(path)).valid, `${path} unexpectedly failed schema validation`).toBe(true);
    }
  });
});

describe('the ready carriers', () => {
  it('seeds revision 0 from the ready example payload', () => {
    const cap = createExecutionPolicyCapability();
    const decision = cap.seedFromReady(examplePayload('event', 'ready'));

    expect(decision?.verdict).toBe('applied');
    expect(cap.tracker.revision).toBe(0);
    expect(cap.tracker.current).toEqual({
      posture: 'smart',
      approvals: 'prompt',
      sandbox: 'required',
      source: 'desktop_local_launch',
      managed_floor_active: false,
    });
  });

  /**
   * The schema marks `execution_policy` REQUIRED on `ready`, yet the bundle's
   * own `compat/events/ready.minimal.json` ships a `ready` without it. The
   * compat fixture wins - that is what `compat/` is for - so an absent receipt
   * is a supported engine, not an error. The tracker must stay uninitialised
   * rather than inventing a revision 0 nobody sent.
   *
   * Staying uninitialised is not the same as staying SILENT. "This engine sends
   * no receipt" and "this engine's receipt was refused" both leave the tracker
   * empty; an operator reading the log has to be able to tell them apart, so
   * the absence is logged when a context is available.
   */
  it('accepts a ready with no receipt at all, stays uninitialised, and says so', () => {
    const cap = createExecutionPolicyCapability();
    const ctx = makeContext();
    const minimal = readFixture('compat/events/ready.minimal.json')[0];

    expect(cap.seedFromReady(minimal, ctx)).toBeNull();
    expect(cap.tracker.current).toBeNull();
    expect(cap.tracker.revision).toBeNull();
    // Absence is not a fault: an old engine is not a stale picture.
    expect(cap.tracker.stale).toBe(false);

    expect(ctx.logs.join(' ')).toContain('no execution_policy');
    expect(ctx.warns).toEqual([]);
    expect(ctx.frames).toEqual([]);
  });

  it('logs an explicitly null receipt rather than returning without a trace', () => {
    const cap = createExecutionPolicyCapability();
    const ctx = makeContext();

    expect(cap.seedFromReady({ type: 'ready', execution_policy: null }, ctx)).toBeNull();
    expect(ctx.logs.join(' ')).toContain('no execution_policy');
  });

  it('logs a ready payload that is not an object at all', () => {
    const cap = createExecutionPolicyCapability();
    const ctx = makeContext();

    expect(cap.seedFromReady('ready', ctx)).toBeNull();
    expect(ctx.logs.join(' ')).toContain('not an object');
  });

  it('survives the other compat ready shapes without adopting anything', () => {
    for (const path of [
      'compat/events/ready.journaled-without-replay.json',
      'compat/events/ready.disabled-by-host.legacy.json',
    ]) {
      const cap = createExecutionPolicyCapability();
      expect(() => cap.seedFromReady(readFixture(path)[0]), path).not.toThrow();
    }
  });

  it('ignores junk in place of a ready payload instead of throwing', () => {
    const cap = createExecutionPolicyCapability();
    expect(cap.seedFromReady(null)).toBeNull();
    expect(cap.seedFromReady('ready')).toBeNull();
    expect(cap.seedFromReady({ type: 'ready', execution_policy: null })).toBeNull();
  });
});

describe('the standalone event through the real dispatcher', () => {
  it('consumes the engine’s example payload and emits one session-scoped frame', () => {
    const cap = createExecutionPolicyCapability();
    const dispatch = createDispatcher([cap]);
    const ctx = makeContext();

    // Revision 1 with no seed: the first receipt of a session is adopted
    // whatever its number, because there is no predecessor to be missing.
    expect(dispatch(examplePayload('event', 'execution_policy'), ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);
    expect(ctx.frames[0].msg_id).toBe('');
    expect(ctx.frames[0].data.verdict).toBe('applied');
    expect(cap.tracker.revision).toBe(1);
    expect(cap.tracker.current?.approvals).toBe('auto_edit');
    expect(ctx.warns).toEqual([]);
  });

  /**
   * The two carriers must reduce to one receipt. `ready.execution_policy` has
   * no `type`; the standalone event does, and it is an envelope discriminator,
   * not part of the receipt. If the host compared raw frames envelope and all,
   * an engine that re-announced revision 0 standalone after `ready` would look
   * like a `conflict` - and the host would refuse the very policy it already
   * holds.
   */
  it('recognises a standalone re-announcement of the ready receipt as the same receipt', () => {
    const cap = createExecutionPolicyCapability();
    const dispatch = createDispatcher([cap]);
    const ctx = makeContext();
    const ready = examplePayload('event', 'ready');

    expect(cap.seedFromReady(ready, ctx)?.verdict).toBe('applied');
    expect(dispatch({ type: 'execution_policy', ...(ready.execution_policy as object) }, ctx)).toBe(true);

    expect(cap.tracker.revision).toBe(0);
    expect(cap.tracker.stale).toBe(false);
    expect(ctx.warns).toEqual([]);
    // Only the seed announced anything: the replay changed nothing.
    expect(ctx.frames).toHaveLength(1);
  });

  /**
   * The frame is what the UI renders, so the staleness it carries has to be the
   * real one. A receipt that fits the chain but is already known to be behind
   * must announce `stale: true` - a frame saying `applied` with `stale: false`
   * is exactly the confident wrong answer this capability exists to remove.
   */
  it('emits stale: true on a frame that applied a receipt the engine has already moved past', () => {
    const cap = createExecutionPolicyCapability();
    const dispatch = createDispatcher([cap]);
    const ctx = makeContext();

    expect(dispatch({ ...seed }, ctx)).toBe(true);
    expect(dispatch({ ...seed, revision: 9 }, ctx)).toBe(true);
    expect(dispatch({ ...seed, revision: 5, reason: 'mode_change' }, ctx)).toBe(true);

    const frame = ctx.frames.at(-1);
    expect(frame?.data.verdict).toBe('applied');
    expect(frame?.data.appliedRevision).toBe(5);
    expect(frame?.data.stale).toBe(true);
  });

  it('consumes workspace_policy without reading a field or emitting anything', () => {
    const cap = createExecutionPolicyCapability();
    const dispatch = createDispatcher([cap]);
    const ctx = makeContext();

    expect(dispatch({ type: 'workspace_policy' }, ctx)).toBe(true);
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns).toEqual([]);
    expect(ctx.logs.join(' ')).toContain('workspace_policy');
  });

  it('does not send commands - the manifest gives this capability none', () => {
    const cap = createExecutionPolicyCapability();
    const dispatch = createDispatcher([cap]);
    const ctx = makeContext();
    // makeContext().sendCommand throws; the dispatcher would swallow that and
    // report the event unhandled, so `true` here also proves no command was sent.
    expect(dispatch(examplePayload('event', 'execution_policy'), ctx)).toBe(true);
    expect(dispatch({ type: 'workspace_policy' }, ctx)).toBe(true);
  });
});

/**
 * Counter-checks: each rule is fired on a hand-built receipt so it is proven to
 * be doing work, rather than being green because the fixture happened not to
 * exercise it.
 */
describe('the reducer’s rules fire on their own', () => {
  const seeded = (): PolicyRevisionTracker => {
    const tracker = new PolicyRevisionTracker();
    expect(tracker.accept(seed).verdict).toBe('applied');
    return tracker;
  };

  it('applies exactly previous + 1', () => {
    const tracker = seeded();
    expect(tracker.accept({ ...seed, revision: 5, reason: 'mode_change' }).verdict).toBe('applied');
    expect(tracker.revision).toBe(5);
  });

  it('rejects previous + 2', () => {
    const tracker = seeded();
    const decision = tracker.accept({ ...seed, revision: 6 });
    expect(decision.verdict).toBe('gap');
    expect(decision.applied).toBe(false);
    expect(tracker.revision).toBe(4);
  });

  it('rejects a revision that moves backwards', () => {
    const tracker = seeded();
    expect(tracker.accept({ ...seed, revision: 3 }).verdict).toBe('regression');
    expect(tracker.revision).toBe(4);
  });

  it('rejects the same revision carrying a different body', () => {
    const tracker = seeded();
    const decision = tracker.accept({ ...seed, policy: { ...seed.policy, approvals: 'bypass' } });
    expect(decision.verdict).toBe('conflict');
    expect(tracker.current?.approvals).toBe('prompt');
  });

  /**
   * Key order is a serialisation detail, not a difference. Without canonical
   * comparison an engine that re-serialises a replay would look like a conflict
   * and the host would refuse a policy it already holds.
   */
  it('treats a reordered replay of the same revision as identical', () => {
    const tracker = seeded();
    const reordered = {
      policy: {
        managed_floor_active: false,
        source: 'desktop_local_launch',
        sandbox: 'required',
        approvals: 'prompt',
        posture: 'smart',
      },
      effective_at_unix_ms: seed.effective_at_unix_ms,
      reason: 'launch',
      revision: 4,
      contract_version: '1.0',
      critical: true,
      type: 'execution_policy',
    };
    expect(tracker.accept(reordered).verdict).toBe('idempotent');
    expect(tracker.stale).toBe(false);
  });

  /**
   * A same-revision receipt whose only difference is the timestamp is still two
   * receipts claiming one identity. Refusing it is the conservative reading of
   * `correlation: "revision"`; if upstream ever states that timestamps may
   * differ freely, this is the assertion to revisit.
   */
  it('rejects the same revision re-stamped with a different effective time', () => {
    const tracker = seeded();
    expect(tracker.accept({ ...seed, effective_at_unix_ms: seed.effective_at_unix_ms + 1 }).verdict).toBe('conflict');
  });

  it('accepts a MINOR subcontract bump but not a MAJOR one', () => {
    const minor = new PolicyRevisionTracker();
    expect(minor.accept({ ...seed, contract_version: '1.7' }).verdict).toBe('applied');

    const major = new PolicyRevisionTracker();
    expect(major.accept({ ...seed, contract_version: '2.0' }).verdict).toBe('version_mismatch');
    expect(major.current).toBeNull();
  });

  it.each([
    ['posture', { ...seed.policy, posture: 'reckless' }],
    ['approvals', { ...seed.policy, approvals: 'always' }],
    ['sandbox', { ...seed.policy, sandbox: 'off' }],
    ['source', { ...seed.policy, source: 'somewhere' }],
    ['managed_floor_active', { ...seed.policy, managed_floor_active: 'yes' }],
  ])('refuses an unreadable %s rather than displaying a posture it cannot map', (_field, policy) => {
    const tracker = seeded();
    expect(tracker.accept({ ...seed, revision: 5, policy }).verdict).toBe('malformed');
    expect(tracker.current?.approvals).toBe('prompt');
    expect(tracker.stale).toBe(true);
  });

  it.each([
    ['missing policy', { ...seed, policy: undefined }],
    ['missing revision', { ...seed, revision: undefined }],
    ['fractional revision', { ...seed, revision: 1.5 }],
    ['missing reason', { ...seed, reason: undefined }],
    ['unknown reason', { ...seed, reason: 'because' }],
    ['missing effective_at_unix_ms', { ...seed, effective_at_unix_ms: undefined }],
    ['empty contract_version', { ...seed, contract_version: '' }],
    ['not an object', 'execution_policy'],
  ])('refuses a receipt with %s', (_label, raw) => {
    const tracker = new PolicyRevisionTracker();
    expect(tracker.accept(raw).verdict).toBe('malformed');
    expect(tracker.current).toBeNull();
  });

  it('carries the dangerous-activation fields through when they are well formed', () => {
    const tracker = new PolicyRevisionTracker();
    const decision = tracker.accept({
      ...seed,
      policy: {
        ...seed.policy,
        posture: 'dangerous',
        approvals: 'bypass',
        sandbox: 'bypass',
        dangerous_activation_id: 'act-1',
        dangerous_expires_at_unix_ms: 1_721_000_060_000,
      },
    });
    expect(decision.verdict).toBe('applied');
    expect(tracker.current?.dangerous_activation_id).toBe('act-1');
    expect(tracker.current?.dangerous_expires_at_unix_ms).toBe(1_721_000_060_000);
  });

  it('refuses a dangerous expiry it cannot read, rather than showing a deadline nobody can trust', () => {
    const tracker = new PolicyRevisionTracker();
    expect(tracker.accept({ ...seed, policy: { ...seed.policy, dangerous_expires_at_unix_ms: 'soon' } }).verdict).toBe(
      'malformed'
    );
  });

  /**
   * A new engine process restarts revisions at 0, which the regression rule
   * would otherwise refuse for the rest of the app's life. `reset` is the only
   * sanctioned way out - deliberately NOT wired to `reason: "resume"`, because
   * whether a resumed session restarts numbering is unstated in the contract.
   */
  it('reset lets a fresh engine start again at revision 0', () => {
    const tracker = seeded();
    expect(tracker.accept({ ...seed, revision: 0 }).verdict).toBe('regression');

    tracker.reset();
    expect(tracker.current).toBeNull();
    expect(tracker.stale).toBe(false);
    expect(tracker.highestAnnouncedRevision).toBeNull();
    expect(tracker.accept({ ...seed, revision: 0 }).verdict).toBe('applied');
  });

  /**
   * State is per engine, not per module. One shared tracker across two engine
   * processes would let one session's revisions reject the other's.
   */
  it('two capability instances do not share revision state', () => {
    const a = createExecutionPolicyCapability();
    const b = createExecutionPolicyCapability();
    expect(a.tracker.accept(seed).verdict).toBe('applied');
    expect(b.tracker.current).toBeNull();
  });
});

/**
 * `stale` is the flag the UI turns into a warning, so what clears it is part of
 * the contract this module offers - and getting it wrong is worse than not
 * having the flag, because a false `stale: false` is an assurance rather than a
 * silence.
 *
 * The rule is NOT "the last receipt fitted the chain". It is "what I hold has
 * caught up with the highest revision the engine has announced". Those differ
 * exactly in the case that matters: the engine announces 9, the host cannot
 * take it, and later receipts walk 5, 6, 7, 8 - each one fitting perfectly, and
 * every one of them provably behind a number the engine already published.
 */
describe('staleness is measured against what the engine announced, not against the last receipt', () => {
  const seeded = (): PolicyRevisionTracker => {
    const tracker = new PolicyRevisionTracker();
    expect(tracker.accept(seed).verdict).toBe('applied');
    return tracker;
  };

  it('latches stale on any rejection', () => {
    const tracker = seeded();
    expect(tracker.accept({ ...seed, revision: 9 }).verdict).toBe('gap');
    expect(tracker.stale).toBe(true);
    expect(tracker.highestAnnouncedRevision).toBe(9);
  });

  it('keeps stale set while in-order receipts are still below the announced high-water mark', () => {
    const tracker = seeded();
    expect(tracker.accept({ ...seed, revision: 9 }).verdict).toBe('gap');

    for (const revision of [5, 6, 7, 8]) {
      const decision = tracker.accept({ ...seed, revision, reason: 'mode_change' });
      expect(decision.verdict, `revision ${revision}`).toBe('applied');
      expect(decision.applied, `revision ${revision}`).toBe(true);
      expect(decision.stale, `revision ${revision} reported the picture as current`).toBe(true);
      expect(tracker.stale, `revision ${revision} cleared the latch`).toBe(true);
    }

    const caughtUp = tracker.accept({ ...seed, revision: 9, reason: 'mode_change' });
    expect(caughtUp.verdict).toBe('applied');
    expect(caughtUp.stale).toBe(false);
    expect(tracker.stale).toBe(false);
  });

  it('says in the detail why an applied receipt is still not the current picture', () => {
    const tracker = seeded();
    tracker.accept({ ...seed, revision: 9 });

    const decision = tracker.accept({ ...seed, revision: 5, reason: 'mode_change' });
    expect(decision.detail).toContain('still behind revision 9');
  });

  /**
   * The high-water mark has to survive a receipt this host could not decode.
   * A receipt whose `policy` carries an unknown enum is refused, but its
   * `revision` is a plain integer and reads perfectly well - and it is the only
   * evidence of how far ahead the engine is. Dropping it would let the very
   * next in-order receipt declare the picture current.
   */
  it('remembers the revision of a receipt whose body it could not read', () => {
    const tracker = seeded();
    const refused = tracker.accept({ ...seed, revision: 9, policy: { ...seed.policy, posture: 'reckless' } });

    expect(refused.verdict).toBe('malformed');
    expect(refused.announcedRevision).toBe(9);
    expect(tracker.highestAnnouncedRevision).toBe(9);

    expect(tracker.accept({ ...seed, revision: 5, reason: 'mode_change' }).stale).toBe(true);
  });

  /**
   * A major-version receipt is refused because this host may be misreading its
   * fields - but its revision number still counts. Whether a 2.0 engine numbers
   * revisions in the same space is unknowable from here, and assuming it does
   * NOT would clear `stale` on the strength of a guess. Conservative wins: the
   * flag stays up.
   */
  it('counts a version-mismatched receipt towards the high-water mark', () => {
    const tracker = seeded();
    expect(tracker.accept({ ...seed, revision: 9, contract_version: '2.0' }).verdict).toBe('version_mismatch');
    expect(tracker.highestAnnouncedRevision).toBe(9);
    expect(tracker.accept({ ...seed, revision: 5, reason: 'mode_change' }).stale).toBe(true);
  });

  it('never lets an older announcement lower the mark', () => {
    const tracker = seeded();
    tracker.accept({ ...seed, revision: 9 });
    expect(tracker.accept({ ...seed, revision: 2 }).verdict).toBe('regression');
    expect(tracker.highestAnnouncedRevision).toBe(9);
  });
});

/**
 * Identity is judged on the whole wire body, not on the part this host models.
 *
 * Both the receipt and its `policy` are `additionalProperties: true`. A host
 * that compares only the fields it understands will grade two contradicting
 * receipts under one revision as `idempotent` - the single verdict that emits
 * nothing, warns nothing and leaves `stale` alone. That is the quietest
 * possible way to lose a safety-class disagreement, and the reason the
 * comparison runs on the raw body.
 */
describe('same-revision identity covers fields this host does not model', () => {
  const seeded = (): PolicyRevisionTracker => {
    const tracker = new PolicyRevisionTracker();
    expect(tracker.accept(seed).verdict).toBe('applied');
    return tracker;
  };

  it('refuses a second body under one revision that differs only inside policy', () => {
    const tracker = seeded();
    const decision = tracker.accept({
      ...seed,
      policy: { ...seed.policy, escalation_window_ms: 5_000 },
    });

    expect(decision.verdict).toBe('conflict');
    expect(decision.detail).toContain('outside the fields this host models');
    expect(tracker.stale).toBe(true);
    // The last VERIFIED posture is what the host keeps acting on.
    expect(tracker.current?.approvals).toBe('prompt');
  });

  it('refuses a second body under one revision that differs only at the top level', () => {
    const tracker = seeded();
    expect(tracker.accept({ ...seed, emitted_by: 'engine-b' }).verdict).toBe('conflict');
  });

  /**
   * The other half of the rule, or the fix would just be "conflict on
   * everything": a replay carrying the SAME unmodelled fields is still a
   * replay, and must stay benign.
   */
  it('still tolerates a replay that carries the same unmodelled fields', () => {
    const tracker = new PolicyRevisionTracker();
    const withExtras = {
      ...seed,
      emitted_by: 'engine-a',
      policy: { ...seed.policy, escalation_window_ms: 5_000 },
    };

    expect(tracker.accept(withExtras).verdict).toBe('applied');
    expect(tracker.accept({ ...withExtras }).verdict).toBe('idempotent');
    expect(tracker.stale).toBe(false);
  });

  it('names the plain case differently from the unmodelled one', () => {
    const tracker = seeded();
    const decision = tracker.accept({ ...seed, policy: { ...seed.policy, approvals: 'bypass' } });

    expect(decision.verdict).toBe('conflict');
    expect(decision.detail).not.toContain('outside the fields');
  });

  it('compares unmodelled structure up to the depth it documents', () => {
    const tracker = new PolicyRevisionTracker();
    expect(tracker.accept({ ...seed, policy: { ...seed.policy, extra: nest(6) } }).verdict).toBe('applied');
  });

  it('refuses a body nested past that depth instead of comparing only part of it', () => {
    const tracker = new PolicyRevisionTracker();
    const decision = tracker.accept({ ...seed, policy: { ...seed.policy, extra: nest(7) } });

    expect(decision.verdict).toBe('malformed');
    expect(decision.detail).toContain('nests deeper');
    // Refusing is loud and keeps nothing: this was the first receipt.
    expect(tracker.current).toBeNull();
    expect(tracker.stale).toBe(true);
  });
});
