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
 * Everything routes through `createDispatcher`, the same function production
 * calls, so what passes here is true of the real routing and not of a stand-in.
 */

import { describe, expect, it } from 'vitest';

import { createDispatcher } from '@process/agent/wcore/capabilities';
import type { CapabilityContext } from '@process/agent/wcore/capabilities/types';
import {
  createExecutionPolicyCapability,
  EXECUTION_POLICY_SUBCONTRACT_VERSION,
  executionPolicyCapability,
  PolicyRevisionTracker,
} from '@process/agent/wcore/capabilities/executionPolicy';
import type {
  ExecutionPolicyCapability,
  ExecutionPolicyFrame,
  PolicyVerdict,
} from '@process/agent/wcore/capabilities/executionPolicy';
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
 * Replay a fixture exactly as the decoder would.
 *
 * `ready` is not dispatched: it has its own arm in the decoder, so its embedded
 * revision-0 receipt enters through `seedFromReady`. Every other line goes
 * through the real dispatcher. Getting this split wrong would silently skip the
 * seed and make every later revision look like a first one.
 */
function replay(relPath: string): { ctx: Recorder; cap: ExecutionPolicyCapability; verdicts: PolicyVerdict[] } {
  const cap = createExecutionPolicyCapability();
  const dispatch = createDispatcher([cap]);
  const ctx = makeContext();
  const verdicts: PolicyVerdict[] = [];

  for (const message of readFixture(relPath)) {
    if (message.type === 'ready') {
      const decision = cap.seedFromReady(message, ctx);
      if (decision) verdicts.push(decision.verdict);
      continue;
    }
    expect(dispatch(message, ctx), `${relPath}: dispatcher did not consume ${String(message.type)}`).toBe(true);
    const last = ctx.frames.at(-1);
    if (last) verdicts.push(last.data.verdict);
  }

  return { ctx, cap, verdicts };
}

describe('the contract surface this capability owns', () => {
  it('claims every event the manifest files under it, and nothing it does not own', () => {
    const surface = surfaceOf(CAPABILITY);
    expect(surface.events.map((e) => e.type)).toEqual(['execution_policy']);
    // No commands: this capability is receive-only, which is why a host cannot
    // ask the engine to re-send a revision it missed. That constraint is what
    // makes the gap rule's cost permanent for the session.
    expect(surface.commands).toEqual([]);
    expect(executionPolicyCapability.handles).toContain('execution_policy');
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
    expect(executionPolicyCapability.handles).toContain('workspace_policy');
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
   */
  it('accepts a ready with no receipt at all and stays uninitialised', () => {
    const cap = createExecutionPolicyCapability();
    const minimal = readFixture('compat/events/ready.minimal.json')[0];

    expect(cap.seedFromReady(minimal)).toBeNull();
    expect(cap.tracker.current).toBeNull();
    expect(cap.tracker.revision).toBeNull();
    // Absence is not a fault: an old engine is not a stale picture.
    expect(cap.tracker.stale).toBe(false);
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
   * not part of the receipt. If the host compared raw frames, an engine that
   * re-announced revision 0 standalone after `ready` would look like a
   * `conflict` - and the host would refuse the very policy it already holds.
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
   * `stale` is the flag the UI turns into a warning, so its lifecycle is part
   * of the contract this module offers: it latches on any rejection and clears
   * only when a receipt lands exactly where one was expected.
   */
  it('latches stale on rejection and clears it only on an in-order receipt', () => {
    const tracker = seeded();
    expect(tracker.accept({ ...seed, revision: 9 }).verdict).toBe('gap');
    expect(tracker.stale).toBe(true);

    expect(tracker.accept({ ...seed, revision: 5, reason: 'mode_change' }).verdict).toBe('applied');
    expect(tracker.stale).toBe(false);
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
