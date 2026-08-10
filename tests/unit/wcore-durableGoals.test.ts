/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Durable goals, driven through the contract's own payloads.
 *
 * WHAT THE BUNDLE GIVES US, AND WHAT IT DOES NOT. `durable_goals_v1` ships
 * eight example payloads (three events, five commands) and ZERO adversarial
 * fixtures: `manifest.subcontracts` has no `durable_goals` entry, there is no
 * `adversarial/goals/` directory, and `compat/` holds no goal payload (the
 * `goal` hits there are the `durable_goals_v1` key inside
 * `contract.capabilities`). Anvil, workflow, policy and recovery each get an
 * ordering/duplicate/gap corpus; goals get none.
 *
 * So two things happen below, and they are kept visibly apart:
 *
 *  1. Everything that CAN be proved against a shipped payload is - and the
 *     strongest of those is that each built command deep-equals the engine's
 *     own example modulo `request_id`. That is what pins which of the two
 *     cursors in `goal_snapshot` a control command must echo; a hand-rolled
 *     payload that merely resembles the fixture would prove nothing.
 *  2. Where a rule has no fixture, the fixtures from `adversarial/recovery/`
 *     are BORROWED - those belong to `turn_recovery_v1`, not to goals - and the
 *     goal-shaped analogues built from them are asserted to pass `validateEvent`
 *     so they remain payloads the engine could legally send. The verdict each
 *     one expects is argued from the manifest's `correlation` grading and the
 *     JSON Schema, never from the fixture's filename.
 *
 *     That directory ships FIVE files, and all five are driven: four for cursor
 *     semantics (`valid-replay`, `cursor-gap`, `cursor-digest-mismatch`,
 *     `state-digest-conflict`) and `version-mismatch` for the version-echo rule,
 *     which is a different question and gets its own test. The count is asserted
 *     below rather than described, so a sixth file arriving fails instead of
 *     being quietly skipped.
 *
 * Routing goes through `createDispatcher`, the same function production builds
 * its dispatcher from, over a handler list this file supplies. It has to supply
 * one: `HANDLERS` in `capabilities/index.ts` does not list this capability yet,
 * so `dispatchCapabilityEvent` would not route to it. Registration is a step
 * outside this file; what is proved here is the reducer, the handler and the
 * builders.
 */

import { describe, expect, it } from 'vitest';

import { createDispatcher, registeredCapabilities, assertNoOverlap } from '@process/agent/wcore/capabilities';
import { dispatchCapabilityEvent } from '@process/agent/wcore/capabilities';
import { negotiateContract } from '@process/agent/wcore/capabilities/contractNegotiation';
import type { NegotiatedContract } from '@process/agent/wcore/capabilities/contractNegotiation';
import type { CapabilityContext } from '@process/agent/wcore/capabilities/types';
import {
  buildGoalAdvance,
  buildGoalCancel,
  buildGoalDeclareTask,
  buildGoalOpen,
  buildGoalResync,
  createDurableGoalsCapability,
  durableGoalsCapability,
  DURABLE_GOALS_CAPABILITY,
  GOAL_EVENT_TYPES,
  MAX_CURSOR_DIGEST_TEXT,
  MAX_DEPENDS_ON_PER_TASK,
  MAX_GOAL_ID_TEXT,
  MAX_GOAL_TEXT,
  MAX_IDEMPOTENCY_KEY_TEXT,
  MAX_RECENT_GOAL_REQUESTS,
  MAX_TASKS_PER_GOAL,
  MAX_TRACKED_GOALS,
  sendGoalCommand,
} from '@process/agent/wcore/capabilities/handlers/durableGoals';
import type {
  BuildOutcome,
  DurableGoalsCapability,
  GoalAdvanceCommand,
  GoalCancelCommand,
  GoalControlRefusedFrame,
  GoalSnapshotFrame,
  GoalTransitionFrame,
  WCoreGoalCommand,
} from '@process/agent/wcore/capabilities/handlers/durableGoals';
import {
  adversarialFixtures,
  entryFor,
  examplePayload,
  readFixture,
  readManifest,
  surfaceOf,
  validateCommand,
  validateEvent,
} from '../helpers/engineContract';

type Frame = { type: string; data: unknown; msg_id: string };

type Recorder = CapabilityContext & {
  frames: Frame[];
  sent: WCoreGoalCommand[];
  logs: string[];
  warns: string[];
};

function makeContext(options: { throwOnSend?: boolean } = {}): Recorder {
  const frames: Frame[] = [];
  const sent: WCoreGoalCommand[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    frames,
    sent,
    logs,
    warns,
    sendCommand: (command) => {
      if (options.throwOnSend === true) throw new Error('ERR_STREAM_DESTROYED');
      sent.push(command as WCoreGoalCommand);
    },
    emit: (frame) => frames.push(frame),
    activeMsgId: () => 'msg-1',
    log: (message) => logs.push(message),
    warn: (message) => warns.push(message),
  };
}

/**
 * `=== false` rather than `!outcome.ok` throughout: this repo compiles without
 * strictNullChecks, where only an explicit comparison narrows a discriminated
 * union.
 */
function unwrap<T>(outcome: BuildOutcome<T>): T {
  if (outcome.ok === false) throw new Error(`expected a command, got a refusal: ${outcome.reason}`);
  return outcome.command;
}

function refusal<T>(outcome: BuildOutcome<T>): string {
  if (outcome.ok === false) return outcome.reason;
  throw new Error('expected a refusal, got a command');
}

/** The engine's own `ready`, which grades `durable_goals_v1` available. */
function availableContract(): NegotiatedContract {
  return negotiateContract(examplePayload('event', 'ready'));
}

const SESSION = 'session-desktop-001';
const GOAL = 'goal-001';

/** `request_id` is the only field a host mints, so it is the only one excluded. */
function withoutRequestId(command: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...command };
  delete copy.request_id;
  return copy;
}

/**
 * `goal_advance` and `goal_cancel` differ only in their `type`, so the cursor
 * proof runs over both through one signature rather than being written twice.
 */
type ControlBuilder = (
  registry: DurableGoalsCapability['goals'],
  contract: NegotiatedContract,
  input: { sessionId: string; goalId: string }
) => BuildOutcome<GoalAdvanceCommand | GoalCancelCommand>;

const CONTROL_BUILDERS: [string, ControlBuilder][] = [
  ['goal_advance', buildGoalAdvance],
  ['goal_cancel', buildGoalCancel],
];

type Harness = { cap: DurableGoalsCapability; ctx: Recorder; dispatch: ReturnType<typeof createDispatcher> };

function harness(options: { throwOnSend?: boolean } = {}): Harness {
  const cap = createDurableGoalsCapability();
  return { cap, ctx: makeContext(options), dispatch: createDispatcher([cap]) };
}

/**
 * A goal-shaped payload carrying a cursor taken from somewhere else.
 *
 * Built from the engine's own `goal_snapshot` example so every field except the
 * ones under test is exactly what the contract ships, and asserted against
 * `validateEvent` by its callers so a "hand-built" case is still something the
 * engine could legally send.
 */
function snapshotWith(cursor: unknown, stateDigest: string, goalId = GOAL): Record<string, unknown> {
  const base = examplePayload('event', 'goal_snapshot');
  return { ...base, goal_id: goalId, cursor, state_digest: stateDigest };
}

function cursorOf(sequence: number, digest: string): Record<string, unknown> {
  return { journal_digest: digest, journal_sequence: sequence };
}

describe('the contract surface this capability owns', () => {
  it('claims every goal event the manifest files under it, and nothing it does not own', () => {
    const surface = surfaceOf(DURABLE_GOALS_CAPABILITY);

    expect(surface.events.map((e) => e.type).toSorted()).toEqual(
      ['goal_control_refused', 'goal_snapshot', 'goal_transition'].toSorted()
    );
    expect([...durableGoalsCapability.handles].toSorted()).toEqual(surface.events.map((e) => e.type).toSorted());
    // A future contract adding a fourth goal event turns this red instead of
    // having it silently dropped by a handler that never claimed it.
    expect([...GOAL_EVENT_TYPES].toSorted()).toEqual(surface.events.map((e) => e.type).toSorted());
  });

  it('covers all five commands the manifest files under it', () => {
    const surface = surfaceOf(DURABLE_GOALS_CAPABILITY);
    expect(surface.commands.map((c) => c.type).toSorted()).toEqual([
      'goal_advance',
      'goal_cancel',
      'goal_declare_task',
      'goal_open',
      'goal_resync',
    ]);
  });

  /**
   * The manifest fields the rules below are argued from. If an engine bump
   * downgrades `goal_control_refused` from safety-class, or moves the
   * observational events off a cursor correlation, the justification for
   * refusing a same-cursor contradiction evaporates and the rules must be
   * re-derived rather than inherited.
   */
  it('still grades the refusal safety-class and still correlates the observations on the cursor', () => {
    expect(entryFor('event', 'goal_control_refused')?.criticality).toBe('safety');
    expect(entryFor('event', 'goal_control_refused')?.correlation).toBe('request_id_and_goal_id');

    for (const type of ['goal_snapshot', 'goal_transition']) {
      expect(entryFor('event', type)?.correlation, type).toBe('goal_id_and_cursor');
      expect(entryFor('event', type)?.criticality, type).toBe('observational');
    }
    for (const type of ['goal_advance', 'goal_cancel']) {
      expect(entryFor('command', type)?.correlation, type).toBe('request_id_goal_id_and_cursor');
    }
    // Every one of the five commands is safety-class - the reason the contract
    // gate below is not optional.
    for (const command of surfaceOf(DURABLE_GOALS_CAPABILITY).commands) {
      expect(command.criticality, command.type).toBe('safety');
    }
  });

  /**
   * There is no `durable_goals` subcontract version, which is why
   * `goal_version` cannot be validated the way `execution_policy` validates
   * `contract_version` against `manifest.subcontracts.execution_policy`. The
   * day one appears, this assertion fails and the version rule gets derived
   * rather than guessed.
   */
  it('has no published subcontract version, so goal_version cannot be range-checked', () => {
    expect(readManifest().subcontracts.durable_goals).toBeUndefined();
    expect(Object.keys(readManifest().subcontracts)).not.toContain('durable_goals');
  });

  /**
   * The bundle ships the eight example payloads and nothing else: no
   * `adversarial/goals/` directory, and no adversarial or compat fixture
   * anywhere that carries a goal payload. That absence is what makes every
   * cursor rule below a borrowed convention rather than a contract obligation,
   * so it is pinned - the day a goal corpus appears, this fails and the rules
   * get re-derived against it instead of inherited.
   */
  it('ships no adversarial goal corpus at all, so the cursor rules below are borrowed conventions', () => {
    expect(adversarialFixtures('goals')).toEqual([]);
    const goalFixtures = readManifest().fixture_inventory.filter((p) => p.includes('goal'));
    expect(goalFixtures.toSorted()).toEqual([
      'commands/goal_advance.json',
      'commands/goal_cancel.json',
      'commands/goal_declare_task.json',
      'commands/goal_open.json',
      'commands/goal_resync.json',
      'events/goal_control_refused.json',
      'events/goal_snapshot.json',
      'events/goal_transition.json',
    ]);
    expect(goalFixtures.filter((p) => p.startsWith('adversarial/') || p.startsWith('compat/'))).toEqual([]);
  });

  /**
   * The borrowed corpus, pinned. `adversarial/recovery/` ships FIVE files and
   * every one of them drives a test below - four for cursor semantics and
   * `version-mismatch` for the version-echo rule. Asserting the list means a
   * sixth file arriving fails here instead of being quietly left undriven,
   * which is what "the fixtures are borrowed" would otherwise be hiding.
   */
  it('borrows all five recovery fixtures, none left undriven', () => {
    expect(adversarialFixtures('recovery')).toEqual([
      'adversarial/recovery/cursor-digest-mismatch.jsonl',
      'adversarial/recovery/cursor-gap.jsonl',
      'adversarial/recovery/state-digest-conflict.jsonl',
      'adversarial/recovery/valid-replay.jsonl',
      'adversarial/recovery/version-mismatch.jsonl',
    ]);
  });

  /**
   * Written before this capability was registered, when the question was "would
   * it collide if added". It is registered now, so appending it to the live
   * registry collides with ITSELF - the honest question became "is it in there,
   * exactly once, and does the whole registry still hold". That is what the
   * dispatcher enforces at module load, so this asserts the same property from
   * the outside rather than simulating an addition that already happened.
   */
  it('is registered exactly once and the whole registry claims no type twice', () => {
    const mine = registeredCapabilities().filter((c) => c.name === durableGoalsCapability.name);
    expect(mine.length, 'durable goals should be registered exactly once').toBe(1);
    expect(() => assertNoOverlap(registeredCapabilities())).not.toThrow();
  });
});

describe('the engine’s own event payloads', () => {
  it.each([...GOAL_EVENT_TYPES])('%s validates against the published core-event schema', (type) => {
    expect(validateEvent(examplePayload('event', type)).valid).toBe(true);
  });

  it('consumes goal_snapshot and emits one session-scoped frame', () => {
    const { cap, ctx, dispatch } = harness();
    const event = examplePayload('event', 'goal_snapshot');

    expect(dispatch(event, ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);

    const frame = ctx.frames[0];
    expect(frame.type).toBe('goal_snapshot');
    // A goal outlives any turn - it is journalled to survive a restart - so it
    // must not be filed under whatever message happens to be open.
    expect(frame.msg_id).toBe('');

    const data = frame.data as GoalSnapshotFrame;
    expect(data.verdict).toBe('seeded');
    expect(data.adopted).toBe(true);
    expect(data.needsResync).toBe(false);
    expect(data.objective).toBe('ship the release candidate');
    expect(data.lifecycleState).toBe('running');
    expect(data.iterationCeiling).toBe(8);
    expect(data.iterationsStarted).toBe(3);
    expect(data.taskCount).toBe(2);
    expect(data.tasksTruncated).toBe(false);
    expect(data.tasks.map((t) => t.taskId)).toEqual(['task-build', 'task-publish']);
    expect(data.tasks[0].outcomeState).toBe('self_checked');
    expect(data.tasks[1].dependsOn).toEqual(['task-build']);

    expect(cap.goals.objectiveFor(SESSION, GOAL)).toBe('ship the release candidate');
    expect(cap.goals.lifecycleStateFor(SESSION, GOAL)).toBe('running');
    expect(ctx.warns).toEqual([]);

    // The retained record is what a read model (Mission Control) will project,
    // so the fields it needs are asserted here rather than only on the frame.
    const record = cap.goals.recordFor(SESSION, GOAL);
    expect(record?.iteration_ceiling).toBe(8);
    expect(record?.authority?.loop_policy?.iterations).toBe(8);
    expect(record?.authority?.strategy).toBe('fleet');
    expect(record?.loop_owner?.lease_expires_unix_ms).toBe(1_721_000_060_000);
    expect(record?.tasks?.[1].depends_on).toEqual(['task-build']);
  });

  it('consumes goal_transition and records its lifecycle even with no goal record attached', () => {
    const { cap, ctx, dispatch } = harness();

    expect(dispatch(examplePayload('event', 'goal_transition'), ctx)).toBe(true);
    const data = ctx.frames[0].data as GoalTransitionFrame;
    expect(data.transition).toBe('loop_owner_claimed');
    expect(data.lifecycleState).toBe('running');
    expect(data.verdict).toBe('seeded');
    expect(cap.goals.lifecycleStateFor(SESSION, GOAL)).toBe('running');
  });

  /**
   * `goal_control_refused` is the safety-class one. Today it is swallowed
   * whole; the point of handling it is that it becomes both an operator warning
   * AND a frame the UI can render, and that it locks the goal until a resync.
   */
  it('warns AND emits on goal_control_refused, and locks the goal until a resync', () => {
    const { cap, ctx, dispatch } = harness();

    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);
    expect(dispatch(examplePayload('event', 'goal_control_refused'), ctx)).toBe(true);

    const frame = ctx.frames.at(-1);
    expect(frame?.type).toBe('goal_control_refused');
    const data = frame?.data as GoalControlRefusedFrame;
    expect(data.reason).toBe('cursor_stale');
    expect(data.requestId).toBe('goal-advance-001');
    expect(data.needsResync).toBe(true);
    // Nothing remembered sending it, so the host says so rather than inventing
    // a command it can no longer name.
    expect(data.refusedCommand).toBeUndefined();
    expect(data.correlationMismatch).toBe(false);

    expect(ctx.warns.join(' ')).toContain('cursor_stale');
    expect(cap.goals.needsResync(SESSION, GOAL)).toBe(true);
  });

  /**
   * Both events are `additionalProperties: true` at every level and none of the
   * nested objects has a required list, so a live payload may legally omit
   * `goal.tasks`, `goal.lifecycle` or `cursor.journal_sequence`. A decoder that
   * dereferences unguarded throws - and the dispatcher swallows a throwing
   * handler, turning a decode bug into a silently unhandled safety-class event.
   */
  it('survives a snapshot whose goal record is empty, without throwing or adopting nonsense', () => {
    const { ctx, dispatch } = harness();
    const event = { ...examplePayload('event', 'goal_snapshot'), goal: {} };

    expect(validateEvent(event).valid).toBe(true);
    expect(dispatch(event, ctx)).toBe(true);
    const data = ctx.frames[0].data as GoalSnapshotFrame;
    expect(data.taskCount).toBe(0);
    expect(data.tasks).toEqual([]);
    expect(data.objective).toBeUndefined();
  });

  it.each([
    ['goal is not an object', { goal: 'ship it' }],
    ['tasks is not an array', { goal: { tasks: 'none' } }],
    ['lifecycle is not an object', { goal: { lifecycle: 'running' } }],
    ['a task entry is not an object', { goal: { tasks: ['task-build'] } }],
  ])('survives a snapshot where %s', (_label, patch) => {
    const { ctx, dispatch } = harness();
    expect(dispatch({ ...examplePayload('event', 'goal_snapshot'), ...patch }, ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);
  });
});

/**
 * The strongest proof in this file. A command built by this module must be the
 * command the contract publishes, field for field - not something that merely
 * validates. `request_id` is the only field a host mints, so it is the only one
 * excluded from the comparison.
 */
describe('every built command deep-equals the engine’s own example, modulo request_id', () => {
  it('goal_open', () => {
    const command = unwrap(
      buildGoalOpen(availableContract(), {
        sessionId: SESSION,
        goalId: GOAL,
        objective: 'ship the desktop contract',
        iterations: 8,
        strategy: 'fleet',
        maxTokens: 10_000,
      })
    );

    expect(validateCommand(command).valid).toBe(true);
    expect(withoutRequestId(command as unknown as Record<string, unknown>)).toEqual(
      withoutRequestId(examplePayload('command', 'goal_open'))
    );
  });

  it('goal_declare_task, with depends_on and idempotency_key as the example sends them', () => {
    const { cap } = harness();
    const command = unwrap(
      buildGoalDeclareTask(cap.goals, availableContract(), {
        sessionId: SESSION,
        goalId: GOAL,
        taskId: 'publish',
        dependsOn: ['build'],
        idempotencyKey: 'idem-publish',
      })
    );

    expect(validateCommand(command).valid).toBe(true);
    expect(withoutRequestId(command as unknown as Record<string, unknown>)).toEqual(
      withoutRequestId(examplePayload('command', 'goal_declare_task'))
    );
  });

  /**
   * `depends_on` and `idempotency_key` are NOT in this command's required list,
   * even though the example sends both. Omitting them when a caller supplies
   * none is the schema's reading, not the example's: an empty `depends_on` is
   * the positive statement "this task depends on nothing", which a caller who
   * simply did not pass one never made.
   */
  it('goal_declare_task omits the two optional fields when the caller supplies none', () => {
    const { cap } = harness();
    const command = unwrap(
      buildGoalDeclareTask(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL, taskId: 'publish' })
    );

    expect(validateCommand(command).valid).toBe(true);
    expect(Object.keys(command)).not.toContain('depends_on');
    expect(Object.keys(command)).not.toContain('idempotency_key');
  });

  /**
   * THE CURSOR TEST. `events/goal_snapshot.json` carries two cursors that
   * disagree - the top-level one (`sha256:goalcursor`) and `goal.cursor`
   * (`9999...`) - and the contract's own `goal_advance` example carries the
   * top-level one. Echoing `goal.cursor` would still produce a schema-valid
   * command, so only this equality catches it.
   */
  it.each(CONTROL_BUILDERS)('%s echoes the TOP-LEVEL cursor of the snapshot, not goal.cursor', (type, build) => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    const command = unwrap(build(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }));

    expect(validateCommand(command).valid).toBe(true);
    expect(withoutRequestId(command as unknown as Record<string, unknown>)).toEqual(
      withoutRequestId(examplePayload('command', type))
    );

    // Said out loud, so a future reader does not have to diff two digests: the
    // two cursors in the snapshot really are different.
    const snapshot = examplePayload('event', 'goal_snapshot');
    const nested = (snapshot.goal as { cursor: { journal_digest: string } }).cursor;
    expect(nested.journal_digest).not.toBe((snapshot.cursor as { journal_digest: string }).journal_digest);
  });

  it('goal_resync with a goal id', () => {
    const { cap } = harness();
    const command = unwrap(buildGoalResync(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }));

    expect(validateCommand(command).valid).toBe(true);
    expect(withoutRequestId(command as unknown as Record<string, unknown>)).toEqual(
      withoutRequestId(examplePayload('command', 'goal_resync'))
    );
  });

  /**
   * `goal_id` is the one field `goal_resync` does not require - unlike every
   * other goal command - though the example sends it. Following the required
   * list rather than the example is what lets a host resync a whole session,
   * and the schema accepting the shorter form is the evidence that the reading
   * is right.
   */
  it('goal_resync omits goal_id entirely when none is supplied, and the schema still accepts it', () => {
    const { cap } = harness();
    const command = unwrap(buildGoalResync(cap.goals, availableContract(), { sessionId: SESSION }));

    expect(Object.keys(command)).not.toContain('goal_id');
    expect(validateCommand(command).valid).toBe(true);
    expect(readManifest().commands.find((c) => c.type === 'goal_resync')).toBeDefined();
  });

  it('mints a distinct request_id per command so two refusals can be told apart', () => {
    const contract = availableContract();
    const open = () =>
      unwrap(
        buildGoalOpen(contract, {
          sessionId: SESSION,
          goalId: GOAL,
          objective: 'ship it',
          iterations: 1,
          strategy: 'fleet',
          maxTokens: 1,
        })
      ).request_id;
    expect(open()).not.toBe(open());
  });
});

/**
 * `goal_version` has no declared meaning: every fixture says 1, and there is no
 * `durable_goals` subcontract to version against. Hardcoding 1 is a coin flip -
 * right if it is a subcontract constant, wrong on every command if it is a
 * per-goal revision. Echoing what the engine last published is right either way.
 */
describe('goal_version is echoed, not assumed', () => {
  it('carries the version the engine published for that goal', () => {
    const { cap, ctx, dispatch } = harness();
    const event = { ...examplePayload('event', 'goal_snapshot'), goal_version: 7 };
    expect(validateEvent(event).valid).toBe(true);
    expect(dispatch(event, ctx)).toBe(true);

    expect(cap.goals.goalVersionFor(SESSION, GOAL)).toBe(7);
    expect(
      unwrap(buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL })).goal_version
    ).toBe(7);
    expect(
      unwrap(buildGoalResync(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL })).goal_version
    ).toBe(7);
  });

  it('falls back to 1 only where there is nothing to echo', () => {
    const { cap } = harness();
    expect(
      unwrap(
        buildGoalOpen(availableContract(), {
          sessionId: SESSION,
          goalId: 'goal-new',
          objective: 'ship it',
          iterations: 1,
          strategy: 'fleet',
          maxTokens: 1,
        })
      ).goal_version
    ).toBe(1);
    expect(unwrap(buildGoalResync(cap.goals, availableContract(), { sessionId: SESSION })).goal_version).toBe(1);
  });
});

/**
 * The gate. Every one of the five commands is safety-class, and a command sent
 * to a build that graded this capability anything but `available` waits for a
 * reply that never comes.
 */
describe('the contract gate', () => {
  const buildAll = (contract: NegotiatedContract, cap: DurableGoalsCapability): BuildOutcome<WCoreGoalCommand>[] => [
    buildGoalOpen(contract, {
      sessionId: SESSION,
      goalId: GOAL,
      objective: 'ship it',
      iterations: 1,
      strategy: 'fleet',
      maxTokens: 1,
    }),
    buildGoalDeclareTask(cap.goals, contract, { sessionId: SESSION, goalId: GOAL, taskId: 'publish' }),
    buildGoalAdvance(cap.goals, contract, { sessionId: SESSION, goalId: GOAL }),
    buildGoalCancel(cap.goals, contract, { sessionId: SESSION, goalId: GOAL }),
    buildGoalResync(cap.goals, contract, { sessionId: SESSION }),
  ];

  /**
   * `compat/events/ready.minimal.json` has NO `contract` field at all - an
   * older engine that must be left alone rather than spoken to. It is the
   * reason the gate cannot be "assume available unless told otherwise".
   */
  it('refuses all five commands against a ready with no contract block (ready.minimal.json)', () => {
    const { cap, ctx, dispatch } = harness();
    const minimal = readFixture('compat/events/ready.minimal.json')[0];
    expect(minimal.contract).toBeUndefined();

    // Seed a real cursor first, so the refusals below are the GATE talking and
    // not a missing cursor.
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    const contract = negotiateContract(minimal);
    for (const outcome of buildAll(contract, cap)) {
      expect(refusal(outcome)).toContain('did not grade durable_goals_v1 as available');
    }
  });

  it.each([
    ['events/ready.json', 'events/ready.json'],
    ['compat/events/ready.disabled-by-host.legacy.json', 'compat/events/ready.disabled-by-host.legacy.json'],
  ])('opens against %s, which grades durable_goals_v1 available', (_label, path) => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    const ready = readFixture(path)[0];
    expect((ready.contract as { capabilities: Record<string, string> }).capabilities.durable_goals_v1).toBe(
      'available'
    );

    const contract = negotiateContract(ready);
    for (const outcome of buildAll(contract, cap)) {
      expect(validateCommand(unwrap(outcome)).valid).toBe(true);
    }
  });

  /**
   * `publication_bound` and `shape_only` are NOT usable grades. `shape_only`
   * means the type exists and the behaviour does not, which is the exact case
   * that hangs on a reply. Both are refused, and so is a grade the engine never
   * mentioned.
   */
  it.each(['publication_bound', 'shape_only', 'unavailable', 'something_new'])('stays closed on grade %s', (grade) => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    const contract = negotiateContract({
      type: 'ready',
      version: '0.12.26',
      contract: { capabilities: { durable_goals_v1: grade } },
    });
    for (const outcome of buildAll(contract, cap)) {
      expect(refusal(outcome)).toContain('did not grade durable_goals_v1 as available');
    }
  });

  it('never writes a command to the engine while the gate is closed', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    const closed = negotiateContract(readFixture('compat/events/ready.minimal.json')[0]);
    const outcome = sendGoalCommand(
      ctx,
      cap.goals,
      buildGoalAdvance(cap.goals, closed, { sessionId: SESSION, goalId: GOAL }),
      () => true
    );

    expect(outcome.ok).toBe(false);
    expect(ctx.sent).toEqual([]);
    expect(cap.goals.recentRequestIds()).toEqual([]);
  });
});

/**
 * Cursor discipline - the one invariant a host can actually get wrong.
 *
 * The three fixtures driven here belong to `turn_recovery_v1`
 * (`adversarial/recovery/`), NOT to durable goals: the bundle ships no goal
 * corpus. They are borrowed for their cursor semantics, and the sequences and
 * digests below are read OUT OF the fixture files rather than typed here, so a
 * change upstream moves the test with it. Every goal-shaped payload built from
 * them is asserted to pass `validateEvent`.
 */
describe('cursor discipline, with the recovery fixtures borrowed as the specification', () => {
  const recoveryCursors = (relPath: string): Record<string, unknown>[] => {
    const messages = readFixture(relPath);
    const snapshot = messages.find((m) => m.type === 'session_recovery_snapshot');
    const replay = messages.find((m) => m.type === 'session_recovery_replay');
    return [snapshot?.cursor as Record<string, unknown>, replay?.from as Record<string, unknown>];
  };

  it('refuses to build a control command for a goal that has published no cursor', () => {
    const { cap } = harness();
    const outcome = buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: 'goal-unseen' });

    // A cursor is a position in the ENGINE's journal. Refusing is the only
    // honest answer; an invented or empty cursor is `cursor_stale` at best.
    expect(refusal(outcome)).toContain('no cursor has been published');
    expect(cap.goals.cursorFor(SESSION, 'goal-unseen')).toBeNull();
  });

  /**
   * `HANDLERS` is a module singleton shared by every `WCoreAgent` in the main
   * process. Without a session-scoped key, two conversations that both opened
   * `goal-001` would answer for each other - and a `goal_cancel` would carry
   * the wrong session's cursor.
   */
  it('keys cursors by session as well as goal, so two conversations cannot answer for each other', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    expect(cap.goals.cursorFor(SESSION, GOAL)).not.toBeNull();
    expect(cap.goals.cursorFor('session-other', GOAL)).toBeNull();
    expect(
      refusal(buildGoalAdvance(cap.goals, availableContract(), { sessionId: 'session-other', goalId: GOAL }))
    ).toContain('no cursor has been published');
  });

  /**
   * valid-replay: cursors 40 -> 42, in order. Adopted, and the cursor a command
   * would carry moves with them.
   */
  it('valid-replay: adopts an in-order pair and echoes the newer cursor', () => {
    const [snapshotCursor, replayFrom] = recoveryCursors('adversarial/recovery/valid-replay.jsonl');
    expect(replayFrom).toEqual(snapshotCursor);

    const { cap, ctx, dispatch } = harness();
    const first = snapshotWith(snapshotCursor, 'digest-a');
    const second = snapshotWith(cursorOf(42, String(snapshotCursor.journal_digest)), 'digest-b');
    expect(validateEvent(first).valid).toBe(true);
    expect(validateEvent(second).valid).toBe(true);

    expect(dispatch(first, ctx)).toBe(true);
    expect(dispatch(second, ctx)).toBe(true);

    expect((ctx.frames[0].data as GoalSnapshotFrame).verdict).toBe('seeded');
    expect((ctx.frames[1].data as GoalSnapshotFrame).verdict).toBe('advanced');
    expect(cap.goals.cursorFor(SESSION, GOAL)?.journal_sequence).toBe(42);
    expect(
      unwrap(buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL })).cursor
    ).toEqual({
      journal_digest: snapshotCursor.journal_digest,
      journal_sequence: 42,
    });
  });

  /**
   * cursor-gap: the recovery fixture jumps 40 -> 42 with 41 never delivered.
   *
   * A GOAL ACCEPTS THIS, and that is the deliberate difference from the
   * revision chain in `executionPolicy`. A policy `revision` is a counter owned
   * by one subsystem, so `previous + 2` means a receipt was lost. A goal cursor
   * is a position in the engine's WHOLE journal, which every other subsystem
   * also writes to, so two consecutive goal snapshots are EXPECTED to sit many
   * sequences apart. Refusing a gap here would refuse ordinary operation.
   * Nothing in the contract states goal cursors are contiguous. The distance is
   * reported rather than treated as a fault.
   */
  it('cursor-gap: accepts a forward jump and reports the distance instead of refusing it', () => {
    const [snapshotCursor] = recoveryCursors('adversarial/recovery/cursor-gap.jsonl');
    const gapped = readFixture('adversarial/recovery/cursor-gap.jsonl').find(
      (m) => m.type === 'session_recovery_replay'
    );
    expect(gapped, 'cursor-gap.jsonl has no session_recovery_replay line').toBeDefined();
    const items = (gapped as { items: { cursor: { journal_sequence: number } }[] }).items;
    const jumpedTo = items[0].cursor.journal_sequence;
    expect(jumpedTo).toBe(Number(snapshotCursor.journal_sequence) + 2);

    const { cap, ctx, dispatch } = harness();
    expect(dispatch(snapshotWith(snapshotCursor, 'digest-a'), ctx)).toBe(true);
    expect(dispatch(snapshotWith(cursorOf(jumpedTo, 'digest-later'), 'digest-b'), ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalSnapshotFrame;
    expect(frame.verdict).toBe('advanced');
    expect(frame.adopted).toBe(true);
    expect(frame.needsResync).toBe(false);
    expect(frame.detail).toContain('1 journal position(s) apart');
    expect(cap.goals.needsResync(SESSION, GOAL)).toBe(false);
  });

  /**
   * cursor-digest-mismatch: the recovery fixture's replay claims to start from
   * sequence 40 with digest `ffff...` while the snapshot published sequence 40
   * with digest `4444...`. Two different journal states claim one position.
   *
   * The manifest grades both observational goal events
   * `correlation: "goal_id_and_cursor"` - the cursor IS the identity of a goal
   * observation - so this is a contradiction, not an update. Adopting the newer
   * one would be last-write-wins on a field the contract names as an identity.
   */
  it('cursor-digest-mismatch: refuses a second digest at one sequence and demands a resync', () => {
    const [snapshotCursor, replayFrom] = recoveryCursors('adversarial/recovery/cursor-digest-mismatch.jsonl');
    expect(replayFrom.journal_sequence).toBe(snapshotCursor.journal_sequence);
    expect(replayFrom.journal_digest).not.toBe(snapshotCursor.journal_digest);

    const { cap, ctx, dispatch } = harness();
    expect(dispatch(snapshotWith(snapshotCursor, 'digest-a'), ctx)).toBe(true);
    expect(dispatch(snapshotWith(replayFrom, 'digest-a'), ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalSnapshotFrame;
    expect(frame.verdict).toBe('digest_conflict');
    expect(frame.adopted).toBe(false);
    expect(frame.needsResync).toBe(true);
    expect(ctx.warns.join(' ')).toContain('digest_conflict');

    // The cursor the host would echo is still the one it verified.
    expect(cap.goals.cursorFor(SESSION, GOAL)?.journal_digest).toBe(snapshotCursor.journal_digest);
    expect(refusal(buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }))).toContain(
      'needs a goal_resync'
    );
  });

  /**
   * state-digest-conflict: the recovery fixture publishes the SAME cursor twice
   * with `state_digest` `aaaa...` then `ffff...`. Same identity, two states.
   */
  it('state-digest-conflict: refuses a second state at one cursor and demands a resync', () => {
    const messages = readFixture('adversarial/recovery/state-digest-conflict.jsonl');
    const [first, second] = messages;
    expect(first.cursor).toEqual(second.cursor);
    expect(first.state_digest).not.toBe(second.state_digest);

    const { cap, ctx, dispatch } = harness();
    expect(dispatch(snapshotWith(first.cursor, String(first.state_digest)), ctx)).toBe(true);
    expect(dispatch(snapshotWith(second.cursor, String(second.state_digest)), ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalSnapshotFrame;
    expect(frame.verdict).toBe('state_conflict');
    expect(frame.needsResync).toBe(true);
    expect(cap.goals.needsResync(SESSION, GOAL)).toBe(true);
  });

  it('tolerates an exact replay of one cursor and state without warning or state change', () => {
    const { cap, ctx, dispatch } = harness();
    const event = examplePayload('event', 'goal_snapshot');

    expect(dispatch(event, ctx)).toBe(true);
    expect(dispatch({ ...event }, ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalSnapshotFrame;
    expect(frame.verdict).toBe('unchanged');
    expect(frame.needsResync).toBe(false);
    expect(cap.goals.needsResync(SESSION, GOAL)).toBe(false);
    expect(ctx.warns).toEqual([]);
  });

  it('refuses a cursor that moves backwards and keeps the newer one', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(snapshotWith(cursorOf(40, 'digest-40'), 'state-a'), ctx)).toBe(true);
    expect(dispatch(snapshotWith(cursorOf(39, 'digest-39'), 'state-b'), ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalSnapshotFrame;
    expect(frame.verdict).toBe('stale_replay');
    expect(frame.adopted).toBe(false);
    expect(cap.goals.cursorFor(SESSION, GOAL)?.journal_sequence).toBe(40);
    // A replay is not a contradiction: it does not force a resync.
    expect(cap.goals.needsResync(SESSION, GOAL)).toBe(false);
  });

  /**
   * The schema requires NEITHER cursor field, so `cursor: {}` is legal. It is
   * also unusable: without a sequence a replay cannot be told from an advance,
   * and without a digest two states at one sequence cannot be told apart.
   * Keeping the last complete cursor beats echoing half of one.
   */
  it.each([
    ['an empty cursor', {}],
    ['a cursor with no sequence', { journal_digest: 'digest-only' }],
    ['a cursor with no digest', { journal_sequence: 41 }],
    ['a cursor with an empty digest', { journal_digest: '', journal_sequence: 41 }],
    ['a cursor with a fractional sequence', { journal_digest: 'd', journal_sequence: 41.5 }],
  ])('declines to adopt %s, keeping the last complete one', (_label, cursor) => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(snapshotWith(cursorOf(40, 'digest-40'), 'state-a'), ctx)).toBe(true);

    const event = snapshotWith(cursor, 'state-b');
    expect(dispatch(event, ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalSnapshotFrame;
    expect(frame.verdict).toBe('uncursored');
    expect(cap.goals.cursorFor(SESSION, GOAL)).toEqual({ journal_digest: 'digest-40', journal_sequence: 40 });
  });

  it('hands out a copy of the cursor, so a caller cannot mutate the registry’s position', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    const command = unwrap(buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }));
    command.cursor.journal_sequence = 9999;
    expect(cap.goals.cursorFor(SESSION, GOAL)?.journal_sequence).toBe(22);
  });
});

/**
 * Recovery. `executionPolicy` can never advance again after a contradiction and
 * accepts that cost because it has no command to recover with. Goals do -
 * `goal_resync` is published for exactly this - so the deadlock is not
 * acceptable here and the resync path is tested end to end.
 */
describe('goal_resync is the way out of a contradicted cursor', () => {
  it('blocks advance and cancel, allows resync, and re-seeds on the answer', () => {
    const contract = availableContract();
    const { cap, ctx, dispatch } = harness();

    expect(dispatch(snapshotWith(cursorOf(40, 'digest-40'), 'state-a'), ctx)).toBe(true);
    expect(dispatch(snapshotWith(cursorOf(40, 'digest-40b'), 'state-a'), ctx)).toBe(true);
    expect(cap.goals.needsResync(SESSION, GOAL)).toBe(true);

    expect(refusal(buildGoalAdvance(cap.goals, contract, { sessionId: SESSION, goalId: GOAL }))).toContain(
      'needs a goal_resync'
    );
    expect(refusal(buildGoalCancel(cap.goals, contract, { sessionId: SESSION, goalId: GOAL }))).toContain(
      'needs a goal_resync'
    );
    // The recovery command itself must stay available, or the goal is dead for
    // the life of the session.
    expect(
      validateCommand(unwrap(buildGoalResync(cap.goals, contract, { sessionId: SESSION, goalId: GOAL }))).valid
    ).toBe(true);

    expect(dispatch(snapshotWith(cursorOf(41, 'digest-41'), 'state-c'), ctx)).toBe(true);
    const frame = ctx.frames.at(-1)?.data as GoalSnapshotFrame;
    expect(frame.verdict).toBe('seeded');
    expect(frame.detail).toContain('after a resync was owed');
    expect(cap.goals.needsResync(SESSION, GOAL)).toBe(false);
    expect(unwrap(buildGoalAdvance(cap.goals, contract, { sessionId: SESSION, goalId: GOAL })).cursor).toEqual({
      journal_digest: 'digest-41',
      journal_sequence: 41,
    });
  });

  /**
   * THE RE-SEED IS NOT UNCONDITIONAL. The flag is set by every refusal and
   * every contradiction - not only after the host sent `goal_resync` - and the
   * answer carries no `request_id` to correlate on, so the next observation may
   * be an ordinary duplicate or out-of-order snapshot, which the contract leaves
   * undeclared. Adopting a cursor that moves BACKWARDS would arm a position the
   * engine has already moved past: advance on it draws the same `cursor_stale`
   * that set the flag, which re-seeds backwards again - a livelock on the
   * safety-class control path.
   */
  it('refuses a backwards cursor while a resync is owed, and keeps the lock', () => {
    const contract = availableContract();
    const { cap, ctx, dispatch } = harness();

    expect(dispatch(snapshotWith(cursorOf(500, 'digest-500'), 'state-a'), ctx)).toBe(true);
    expect(dispatch(examplePayload('event', 'goal_control_refused'), ctx)).toBe(true);
    expect(cap.goals.needsResync(SESSION, GOAL)).toBe(true);

    const backwards = snapshotWith(cursorOf(10, 'digest-10'), 'state-b');
    expect(validateEvent(backwards).valid).toBe(true);
    expect(dispatch(backwards, ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalSnapshotFrame;
    expect(frame.verdict).toBe('stale_replay');
    expect(frame.adopted).toBe(false);
    expect(frame.needsResync).toBe(true);
    expect(frame.detail).toContain('cannot be the resync');
    expect(cap.goals.cursorFor(SESSION, GOAL)?.journal_sequence).toBe(500);
    expect(refusal(buildGoalAdvance(cap.goals, contract, { sessionId: SESSION, goalId: GOAL }))).toContain(
      'needs a goal_resync'
    );
  });

  /**
   * The other side of that gate, and the reason it is `>=` rather than `>`: the
   * recovery from a `digest_conflict` is the engine restating ONE position with
   * the digest it really holds. Refusing an equal sequence would leave the goal
   * locked for the life of the session - the deadlock `goal_resync` exists to
   * avoid.
   */
  it('re-seeds on an equal sequence with a new digest, which is what a resync answers with', () => {
    const contract = availableContract();
    const { cap, ctx, dispatch } = harness();

    expect(dispatch(snapshotWith(cursorOf(40, 'digest-40'), 'state-a'), ctx)).toBe(true);
    expect(dispatch(snapshotWith(cursorOf(40, 'digest-40b'), 'state-a'), ctx)).toBe(true);
    expect(cap.goals.needsResync(SESSION, GOAL)).toBe(true);

    expect(dispatch(snapshotWith(cursorOf(40, 'digest-40-real'), 'state-c'), ctx)).toBe(true);
    const frame = ctx.frames.at(-1)?.data as GoalSnapshotFrame;
    expect(frame.verdict).toBe('seeded');
    expect(frame.needsResync).toBe(false);
    expect(unwrap(buildGoalAdvance(cap.goals, contract, { sessionId: SESSION, goalId: GOAL })).cursor).toEqual({
      journal_digest: 'digest-40-real',
      journal_sequence: 40,
    });
  });

  /**
   * EVERY refusal locks the goal, not only `cursor_stale`. `reason` is a free
   * string and the bundle enumerates none, so this host cannot tell a transient
   * refusal from a permanent one, nor a cursor problem from an authorisation
   * one. The cost of this choice is one extra resync after an unrelated
   * refusal; the cost of the alternative is repeating a control command against
   * a cursor the engine has already rejected.
   */
  it.each(['cursor_stale', 'managed_policy', 'something_the_host_has_never_heard_of'])(
    'locks the goal after a refusal carrying reason %s',
    (reason) => {
      const { cap, ctx, dispatch } = harness();
      expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);
      expect(dispatch({ ...examplePayload('event', 'goal_control_refused'), reason }, ctx)).toBe(true);

      expect(cap.goals.needsResync(SESSION, GOAL)).toBe(true);
      expect(refusal(buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }))).toContain(
        'needs a goal_resync'
      );
    }
  );

  it('names the command a refusal answers when the host still remembers sending it', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    const sent = sendGoalCommand(
      ctx,
      cap.goals,
      buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }),
      () => true
    );
    expect(sent.ok).toBe(true);
    if (sent.ok === false) throw new Error(sent.reason);

    expect(dispatch({ ...examplePayload('event', 'goal_control_refused'), request_id: sent.requestId }, ctx)).toBe(
      true
    );

    const frame = ctx.frames.at(-1)?.data as GoalControlRefusedFrame;
    expect(frame.refusedCommand).toBe('goal_advance');
    expect(frame.correlationMismatch).toBe(false);
    expect(frame.detail).toContain('goal_advance');
    // The entry is retired once it is answered.
    expect(cap.goals.recentRequestIds()).not.toContain(sent.requestId);
  });
});

/**
 * Refusal correlation, on BOTH fields the manifest names.
 *
 * `goal_control_refused` is graded `correlation: "request_id_and_goal_id"` and
 * is the only safety-class EVENT this capability owns. `request_id` alone is
 * not the correlation the contract states, and treating it as one gets every
 * part of the answer wrong at once: it names a command the goal never sent,
 * retires the entry so the real refusal cannot be named later, and locks a goal
 * the engine said nothing about while leaving the sender unlocked.
 */
describe('a refusal is correlated on request_id AND goal_id AND session', () => {
  /** Seed a cursor for GOAL and send one `goal_advance` for it. */
  function seededWithSentAdvance(): { harness: Harness; requestId: string } {
    const h = harness();
    expect(h.dispatch(examplePayload('event', 'goal_snapshot'), h.ctx)).toBe(true);
    const sent = sendGoalCommand(
      h.ctx,
      h.cap.goals,
      buildGoalAdvance(h.cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }),
      () => true
    );
    if (sent.ok === false) throw new Error(sent.reason);
    return { harness: h, requestId: sent.requestId };
  }

  it('refuses to name the sent command when the refusal names a DIFFERENT goal', () => {
    const { harness: h, requestId } = seededWithSentAdvance();
    const { cap, ctx, dispatch } = h;

    const strayGoal = 'goal-SOMEONE-ELSE';
    const refused = { ...examplePayload('event', 'goal_control_refused'), request_id: requestId, goal_id: strayGoal };
    expect(validateEvent(refused).valid).toBe(true);
    expect(dispatch(refused, ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalControlRefusedFrame;
    // The engine and this host disagree about what that id names. Neither claim
    // is presented as the answer.
    expect(frame.refusedCommand).toBeUndefined();
    expect(frame.correlationMismatch).toBe(true);
    expect(frame.detail).toContain(GOAL);
    expect(frame.detail).toContain(strayGoal);

    // The entry SURVIVES, so the real refusal can still be named.
    expect(cap.goals.recentRequestIds()).toContain(requestId);
    expect(dispatch({ ...examplePayload('event', 'goal_control_refused'), request_id: requestId }, ctx)).toBe(true);
    const answered = ctx.frames.at(-1)?.data as GoalControlRefusedFrame;
    expect(answered.refusedCommand).toBe('goal_advance');
  });

  /**
   * The other half of the same defect: a refusal arrived for a command this host
   * sent against goal-001's cursor, so that cursor is no longer known-good even
   * though the engine named some other goal. Locking it is the fail-closed
   * reading of a contradiction the contract does not explain.
   */
  it('locks the goal the host actually sent that request_id for', () => {
    const { harness: h, requestId } = seededWithSentAdvance();
    const { cap, ctx, dispatch } = h;

    expect(cap.goals.needsResync(SESSION, GOAL)).toBe(false);
    expect(
      dispatch(
        { ...examplePayload('event', 'goal_control_refused'), request_id: requestId, goal_id: 'goal-SOMEONE-ELSE' },
        ctx
      )
    ).toBe(true);

    expect(cap.goals.needsResync(SESSION, GOAL)).toBe(true);
    expect(refusal(buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }))).toContain(
      'needs a goal_resync'
    );
  });

  /**
   * `HANDLERS` is one singleton for every agent, so two conversations can hold
   * the same goal id. A refusal that matches on the id but not the session is
   * the same contradiction as one that matches on neither.
   */
  it('refuses to name the sent command when the refusal names a different SESSION', () => {
    const { harness: h, requestId } = seededWithSentAdvance();
    const { cap, ctx, dispatch } = h;

    expect(
      dispatch(
        { ...examplePayload('event', 'goal_control_refused'), request_id: requestId, session_id: 'session-other' },
        ctx
      )
    ).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalControlRefusedFrame;
    expect(frame.refusedCommand).toBeUndefined();
    expect(frame.correlationMismatch).toBe(true);
    expect(cap.goals.recentRequestIds()).toContain(requestId);
  });

  /**
   * `goal_resync` is the ONE command whose schema does not require `goal_id`,
   * and a session-wide one is a positive statement about every goal in the
   * session - so a refusal naming any of them answers it. It is not retired on
   * the first: one session-wide command may draw one refusal per goal, and
   * retiring early would make the rest read "an unremembered goal command".
   */
  it('treats a session-wide goal_resync as answering a refusal for any goal in that session', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    const sent = sendGoalCommand(
      ctx,
      cap.goals,
      buildGoalResync(cap.goals, availableContract(), { sessionId: SESSION }),
      () => true
    );
    if (sent.ok === false) throw new Error(sent.reason);
    expect(Object.keys(unwrap(buildGoalResync(cap.goals, availableContract(), { sessionId: SESSION })))).not.toContain(
      'goal_id'
    );

    for (const goalId of [GOAL, 'goal-002']) {
      expect(
        dispatch(
          { ...examplePayload('event', 'goal_control_refused'), request_id: sent.requestId, goal_id: goalId },
          ctx
        )
      ).toBe(true);
      const frame = ctx.frames.at(-1)?.data as GoalControlRefusedFrame;
      expect(frame.refusedCommand, goalId).toBe('goal_resync');
      expect(frame.correlationMismatch, goalId).toBe(false);
    }
    expect(cap.goals.recentRequestIds()).toContain(sent.requestId);
  });

  /**
   * `goal_id` on a refusal is wire-controlled, so answering one must never
   * ALLOCATE a registry slot. The measurement in the review: one real snapshot
   * plus 64 refusals naming goals that do not exist left the registry holding 64
   * ghosts and the real goal's cursor evicted, so its buttons stopped working.
   */
  it('never allocates a tracked goal from a refusal, so ghost goal_ids cannot evict a real cursor', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    for (let i = 0; i < MAX_TRACKED_GOALS; i += 1) {
      expect(dispatch({ ...examplePayload('event', 'goal_control_refused'), goal_id: `ghost-${i}` }, ctx)).toBe(true);
    }

    expect(cap.goals.trackedKeys()).toHaveLength(1);
    expect(cap.goals.cursorFor(SESSION, GOAL)).not.toBeNull();
    expect(cap.goals.cursorFor(SESSION, 'ghost-0')).toBeNull();
    expect(
      validateCommand(unwrap(buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL })))
        .valid
    ).toBe(true);
  });

  /**
   * The honest frame for a goal with no held cursor: nothing was locked, because
   * there was nothing to lock. Saying `needsResync: true` there would claim a
   * state change that did not happen.
   */
  it('reports that nothing was locked when the refused goal has no held cursor', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch({ ...examplePayload('event', 'goal_control_refused'), goal_id: 'goal-unseen' }, ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalControlRefusedFrame;
    expect(frame.needsResync).toBe(false);
    expect(frame.detail).toContain('nothing to lock');
    expect(cap.goals.trackedKeys()).toEqual([]);
    // Still not controllable - for the honest reason.
    expect(
      refusal(buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: 'goal-unseen' }))
    ).toContain('no cursor has been published');
  });

  /**
   * `goal_version` is REQUIRED on `goal_control_refused` too, so a refusal is
   * the engine restating it - and the next command built for that goal must
   * carry the restated one, not the one from the last snapshot.
   */
  it('echoes the goal_version a refusal published on the next command', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch({ ...examplePayload('event', 'goal_snapshot'), goal_version: 7 }, ctx)).toBe(true);
    expect(cap.goals.goalVersionFor(SESSION, GOAL)).toBe(7);

    const refused = { ...examplePayload('event', 'goal_control_refused'), goal_version: 9 };
    expect(validateEvent(refused).valid).toBe(true);
    expect(dispatch(refused, ctx)).toBe(true);

    expect(cap.goals.goalVersionFor(SESSION, GOAL)).toBe(9);
    // `goal_resync` is the only command still buildable once the goal is locked.
    expect(
      unwrap(buildGoalResync(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL })).goal_version
    ).toBe(9);
  });

  /** The engine controls `reason`, and this handler copies it three times. */
  it('clamps an over-long refusal reason and says it clamped it', () => {
    const { ctx, dispatch } = harness();
    const reason = 'r'.repeat(MAX_GOAL_TEXT + 500);
    expect(dispatch({ ...examplePayload('event', 'goal_control_refused'), reason }, ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalControlRefusedFrame;
    expect(frame.reason).toHaveLength(MAX_GOAL_TEXT);
    expect(frame.detail).toContain(`clamped from ${reason.length} characters`);
  });
});

/**
 * Malformed input, in both directions.
 *
 * There is no goal-specific malformed corpus, so the `adversarial/commands/`
 * fixtures - which are `continue_with_budget` and `message` payloads - are
 * driven here for one purpose only: to prove the schema gate every other
 * assertion in this file leans on actually says no to something. Without that,
 * every `validateCommand(...).valid === true` above is vacuous.
 */
describe('malformed input hygiene', () => {
  /**
   * MEASURED, one fixture at a time, rather than asserted wholesale. Two of the
   * sixteen shipped files are not JSON at all, and one is a schema BLIND SPOT:
   * `continue-with-budget-overflow-tokens.jsonl` carries 2^64, which is the
   * same IEEE-754 double as the schema's `maximum` of 2^64-1, so ajv accepts
   * it. Claiming "every adversarial fixture is rejected" would be false.
   */
  const REJECTED_BY_SCHEMA = [
    'continue-with-budget-empty-request-id.jsonl',
    'continue-with-budget-empty.jsonl',
    'continue-with-budget-long-request-id.jsonl',
    'continue-with-budget-missing-request-id.jsonl',
    'continue-with-budget-negative-cost.jsonl',
    'continue-with-budget-unicode-request-id.jsonl',
    'continue-with-budget-unknown-field.jsonl',
    'continue-with-budget-wrong-numeric-type.jsonl',
    'missing-type.jsonl',
    'non-object.jsonl',
    'non-string-type.jsonl',
    'unknown-type.jsonl',
    'wrong-required-field.jsonl',
  ];
  const NOT_JSON = ['continue-with-budget-whitespace-request-id.jsonl', 'invalid-json.jsonl'];
  const ACCEPTED_BY_SCHEMA = ['continue-with-budget-overflow-tokens.jsonl'];

  it.each(REJECTED_BY_SCHEMA)('the command schema rejects %s', (file) => {
    expect(validateCommand(readFixture(`adversarial/commands/${file}`)[0]).valid).toBe(false);
  });

  it.each(NOT_JSON)('%s is not parseable JSON, so it never reaches the validator', (file) => {
    expect(() => readFixture(`adversarial/commands/${file}`)).toThrow(/not valid JSON/);
  });

  it.each(ACCEPTED_BY_SCHEMA)('%s passes the schema - a bound the validator cannot police', (file) => {
    expect(validateCommand(readFixture(`adversarial/commands/${file}`)[0]).valid).toBe(true);
  });

  it('every shipped adversarial command fixture is accounted for above', () => {
    const shipped = adversarialFixtures('commands').map((p) => p.replace('adversarial/commands/', ''));
    expect(shipped).toEqual([...REJECTED_BY_SCHEMA, ...NOT_JSON, ...ACCEPTED_BY_SCHEMA].toSorted());
  });

  /**
   * The honest boundary of "validate against the contract" for THIS capability.
   * Unlike `continue_with_budget`, every goal command branch is
   * `additionalProperties: true`, so an invented field passes the schema and
   * would reach the engine as something it never declared. The builders are the
   * only guard, which is why they assemble field-by-field and never spread a
   * caller's object.
   */
  it('the schema cannot catch an unknown field on a goal command, so the builder must', () => {
    const withJunk = { ...examplePayload('command', 'goal_advance'), future_authority: true };
    expect(validateCommand(withJunk).valid).toBe(true);

    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);
    const built = unwrap(buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }));
    expect(Object.keys(built).toSorted()).toEqual([
      'cursor',
      'goal_id',
      'goal_version',
      'request_id',
      'session_id',
      'type',
    ]);
  });

  /**
   * The goal command branches declare `goal_id`/`task_id`/`session_id` as bare
   * `type: string` - no pattern, no minLength - so the schema accepts an empty
   * one. The engine DOES publish a pattern for the same class of field on
   * `continue_with_budget`, together with fixtures aimed at empty, whitespace,
   * over-long and emoji ids; that is its own statement of what it polices, and
   * it is reused here. It matters because `goal_control_refused` is routed back
   * by `request_id` alone.
   */
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['emoji', '\u{1F600}\u{1F600}'],
    ['over-long', 'g'.repeat(129)],
    ['leading punctuation', '-goal'],
    ['not a string', 7],
  ])('refuses a %s goal_id rather than sending an uncorrelatable command', (_label, goalId) => {
    const outcome = buildGoalOpen(availableContract(), {
      sessionId: SESSION,
      goalId: goalId as string,
      objective: 'ship it',
      iterations: 1,
      strategy: 'fleet',
      maxTokens: 1,
    });
    expect(refusal(outcome)).toContain('goal_id');
  });

  /**
   * The refused FIELD is asserted, not merely that something was refused. Every
   * reason string in the module is non-empty, so `length > 0` would pass for a
   * validator that rejects the right input for the wrong reason - which is the
   * bug this table is meant to catch.
   */
  it.each([
    ['an empty objective', { objective: '' }, 'objective'],
    ['a whitespace objective', { objective: '   ' }, 'objective'],
    ['a non-string objective', { objective: 7 }, 'objective'],
    ['zero iterations', { iterations: 0 }, 'iterations'],
    ['negative iterations', { iterations: -1 }, 'iterations'],
    ['fractional iterations', { iterations: 1.5 }, 'iterations'],
    ['a non-number iterations', { iterations: '8' }, 'iterations'],
    ['zero max_tokens', { maxTokens: 0 }, 'max_tokens'],
    ['a non-number max_tokens', { maxTokens: '10000' }, 'max_tokens'],
    ['an empty strategy', { strategy: '' }, 'strategy'],
  ])('refuses goal_open with %s, naming that field', (_label, patch, field) => {
    const outcome = buildGoalOpen(availableContract(), {
      sessionId: SESSION,
      goalId: GOAL,
      objective: 'ship it',
      iterations: 8,
      strategy: 'fleet',
      maxTokens: 10_000,
      ...(patch as object),
    });
    expect(refusal(outcome)).toContain(field);
  });

  /**
   * `idempotency_key` was policed by the correlation-id pattern borrowed from
   * `continue_with_budget.request_id`. That argument does not carry: the schema
   * declares this field a bare `type: string`, it is CALLER-supplied rather than
   * host-minted, and nothing correlates on it - so the pattern refused ordinary
   * keys the contract permits. These two are the reviewer's own examples.
   */
  it.each([
    ['a base64/hash-shaped key', 'sha256:abc/def+ghi='],
    ['a key with a space', 'idem publish'],
    ['a bare uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    [`a key at the ${MAX_IDEMPOTENCY_KEY_TEXT}-character bound`, 'k'.repeat(MAX_IDEMPOTENCY_KEY_TEXT)],
  ])('accepts %s as an idempotency_key, and the schema still takes the command', (_label, key) => {
    const { cap } = harness();
    const command = unwrap(
      buildGoalDeclareTask(cap.goals, availableContract(), {
        sessionId: SESSION,
        goalId: GOAL,
        taskId: 'publish',
        idempotencyKey: key,
      })
    );
    expect(command.idempotency_key).toBe(key);
    expect(validateCommand(command).valid).toBe(true);
  });

  /**
   * What is still refused, and why each one is the host's call rather than the
   * contract's: a non-string cannot be serialised as one; empty or
   * whitespace-only identifies nothing; a control character breaks every log
   * line the key appears in; and past the bound this host will not write an
   * unbounded string to the engine's stdin. Refused rather than truncated - a
   * truncated idempotency key is a different key.
   */
  it.each([
    ['not a string', 7, 'must be a string'],
    ['empty', '', 'empty'],
    ['whitespace-only', '   ', 'empty'],
    ['carrying a newline', 'idem\npublish', 'control characters'],
    ['carrying a NUL', 'idem' + String.fromCharCode(0) + 'publish', 'control characters'],
    ['one character over the bound', 'k'.repeat(MAX_IDEMPOTENCY_KEY_TEXT + 1), 'at most'],
  ])('refuses an idempotency_key that is %s', (_label, key, expected) => {
    const { cap } = harness();
    const outcome = buildGoalDeclareTask(cap.goals, availableContract(), {
      sessionId: SESSION,
      goalId: GOAL,
      taskId: 'publish',
      idempotencyKey: key as string,
    });
    expect(refusal(outcome)).toContain('idempotency_key');
    expect(refusal(outcome)).toContain(expected);
  });

  it('refuses a depends_on that is not an array of strings', () => {
    const { cap } = harness();
    for (const dependsOn of [['build', 7], 'build', [null]]) {
      const outcome = buildGoalDeclareTask(cap.goals, availableContract(), {
        sessionId: SESSION,
        goalId: GOAL,
        taskId: 'publish',
        dependsOn: dependsOn as string[],
      });
      expect(refusal(outcome)).toContain('depends_on');
    }
  });

  it('copies depends_on rather than holding the caller’s array', () => {
    const { cap } = harness();
    const dependsOn = ['build'];
    const command = unwrap(
      buildGoalDeclareTask(cap.goals, availableContract(), {
        sessionId: SESSION,
        goalId: GOAL,
        taskId: 'publish',
        dependsOn,
      })
    );
    dependsOn.push('mutated');
    expect(command.depends_on).toEqual(['build']);
  });

  /**
   * A malformed EVENT is warned about and declined. Declining lets it reach the
   * decoder's acknowledged-unhandled check, which is the honest destination for
   * a payload this host could not read; claiming `true` would report it as
   * handled. The warn is what stops the decline being silent while these three
   * types are still listed inert in `ACKNOWLEDGED_UNHANDLED_EVENTS`.
   */
  it.each([
    ['session_id missing', 'goal_snapshot', { session_id: undefined }],
    ['session_id not a string', 'goal_snapshot', { session_id: 7 }],
    ['session_id empty', 'goal_snapshot', { session_id: '' }],
    ['goal_id missing', 'goal_snapshot', { goal_id: undefined }],
    ['goal_version not an integer', 'goal_snapshot', { goal_version: '1' }],
    ['goal_version fractional', 'goal_snapshot', { goal_version: 1.5 }],
    ['state_digest missing', 'goal_snapshot', { state_digest: undefined }],
    ['state_digest not a string', 'goal_snapshot', { state_digest: 7 }],
    ['transition missing', 'goal_transition', { transition: undefined }],
    ['transition empty', 'goal_transition', { transition: '' }],
    ['request_id missing', 'goal_control_refused', { request_id: undefined }],
    ['request_id empty', 'goal_control_refused', { request_id: '' }],
    ['reason missing', 'goal_control_refused', { reason: undefined }],
    ['reason empty', 'goal_control_refused', { reason: '' }],
  ])('declines %s on %s, loudly', (_label, type, patch) => {
    const { ctx, dispatch } = harness();
    const event = { ...examplePayload('event', type), ...(patch as object) };

    expect(dispatch(event, ctx)).toBe(false);
    expect(ctx.warns.join(' ')).toContain('could not be decoded');
    expect(ctx.frames).toEqual([]);
  });

  it('does not track a goal whose envelope it refused', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch({ ...examplePayload('event', 'goal_snapshot'), state_digest: 7 }, ctx)).toBe(false);
    expect(cap.goals.trackedKeys()).toEqual([]);
  });
});

describe('routing', () => {
  /**
   * Registering this capability must not turn the decoder into a swallow-all.
   * The three unknown-shaped event fixtures are the engine's own statement of
   * what an unrecognised event looks like; none of them may be claimed here.
   */
  it.each([
    'adversarial/events/unknown-critical.jsonl',
    'adversarial/events/unknown-noncritical.jsonl',
    'adversarial/events/unknown-criticality.jsonl',
  ])('declines %s so it still reaches the acknowledged-unhandled check', (path) => {
    const { ctx, dispatch } = harness();
    const event = readFixture(path)[0];

    expect([...durableGoalsCapability.handles]).not.toContain(event.type);
    expect(dispatch(event, ctx)).toBe(false);
    // Declining an event nobody claimed is not a fault, so it must not warn.
    expect(ctx.warns).toEqual([]);
    expect(dispatchCapabilityEvent(event, ctx)).toBe(false);
  });

  it('declines an event with no type at all', () => {
    const { ctx, dispatch } = harness();
    expect(dispatch({ goal_id: GOAL }, ctx)).toBe(false);
  });

  /**
   * `handle` is a public member of `CapabilityHandler` and nothing forces a
   * caller to reach it through the dispatcher, so its own two entry guards are
   * exercised directly. Without this they would be unreachable code that no
   * mutation could kill - decoration rather than defence.
   */
  it('declines a direct call carrying no type SILENTLY - that is a caller error, not an engine one', () => {
    const { cap, ctx } = harness();
    expect(cap.handle({ session_id: SESSION, goal_id: GOAL, goal_version: 1 }, ctx)).toBe(false);
    expect(ctx.frames).toEqual([]);
    // No warning: the dispatcher would never have routed a typeless event here,
    // so this can only be a direct call and warning about it would report a
    // host bug as an engine one. The typed-but-unknown case below DOES warn.
    expect(ctx.warns).toEqual([]);
  });

  it('declines a direct call for a goal type it has no decoder arm for', () => {
    const { cap, ctx } = harness();
    const event = { type: 'goal_retired', session_id: SESSION, goal_id: GOAL, goal_version: 1 };

    expect(cap.handle(event, ctx)).toBe(false);
    expect(ctx.warns.join(' ')).toContain('no decoder arm claims this type');
    // The set of arms and the set of claimed types must stay in step; a fourth
    // goal event added to `handles` without an arm lands here rather than being
    // reported as handled.
    expect([...cap.handles]).not.toContain(event.type);
  });

  /**
   * A throwing handler must never take the turn down. The dispatcher isolates
   * it; this proves the isolation covers this capability too rather than
   * assuming it.
   */
  it('is contained by the dispatcher if the context itself throws', () => {
    const { cap, ctx } = harness();
    const dispatch = createDispatcher([cap]);
    const hostile: CapabilityContext = {
      ...ctx,
      emit: () => {
        throw new Error('renderer is gone');
      },
    };
    expect(() => dispatch(examplePayload('event', 'goal_snapshot'), hostile)).not.toThrow();
  });

  it('two capability instances do not share cursor state', () => {
    const a = createDurableGoalsCapability();
    const b = createDurableGoalsCapability();
    const ctx = makeContext();

    expect(createDispatcher([a])(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);
    expect(a.goals.cursorFor(SESSION, GOAL)).not.toBeNull();
    expect(b.goals.cursorFor(SESSION, GOAL)).toBeNull();
  });

  it('reset forgets every goal, for a new engine process', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);
    cap.reset();
    expect(cap.goals.trackedKeys()).toEqual([]);
    expect(cap.goals.cursorFor(SESSION, GOAL)).toBeNull();
  });
});

/**
 * Bounds. `HANDLERS` is a module singleton with no teardown hook, so anything
 * the wire can grow has to be capped or a long-lived main process leaks.
 */
describe('everything the wire controls is bounded', () => {
  it(`holds at most ${MAX_TRACKED_GOALS} goals, evicting the oldest`, () => {
    const { cap, ctx, dispatch } = harness();

    for (let i = 0; i < MAX_TRACKED_GOALS + 1; i += 1) {
      expect(dispatch(snapshotWith(cursorOf(40 + i, `digest-${i}`), `state-${i}`, `goal-${i}`), ctx)).toBe(true);
    }

    expect(cap.goals.trackedKeys()).toHaveLength(MAX_TRACKED_GOALS);
    expect(cap.goals.cursorFor(SESSION, 'goal-0')).toBeNull();
    expect(cap.goals.cursorFor(SESSION, `goal-${MAX_TRACKED_GOALS}`)).not.toBeNull();
    // Losing a cursor costs the user the advance and cancel buttons for that
    // goal. Saying which goal and why beats a button that quietly stops working.
    expect(ctx.warns.join(' ')).toContain('stopped tracking goal "goal-0"');
    expect(ctx.warns.join(' ')).toContain('goal_resync');
  });

  /**
   * Eviction order is LEAST-RECENTLY-OBSERVED, not insertion. Insertion order
   * drops the OLDEST goal, which is the longest-running one - exactly the goal
   * whose cursor is still needed to CANCEL it, and the opposite of what the
   * module's own rationale for holding finished goals argues for.
   */
  it('keeps a goal that is still publishing and evicts one that went quiet', () => {
    const { cap, ctx, dispatch } = harness();

    expect(dispatch(snapshotWith(cursorOf(1, 'digest-old'), 'state-0', 'goal-long-running'), ctx)).toBe(true);
    expect(dispatch(snapshotWith(cursorOf(1, 'digest-quiet'), 'state-0', 'goal-went-quiet'), ctx)).toBe(true);

    // The long-running goal keeps reporting; the quiet one never does again.
    for (let i = 0; i < MAX_TRACKED_GOALS - 1; i += 1) {
      expect(dispatch(snapshotWith(cursorOf(2 + i, `d-${i}`), `s-${i}`, 'goal-long-running'), ctx)).toBe(true);
      expect(dispatch(snapshotWith(cursorOf(40 + i, `f-${i}`), `t-${i}`, `goal-filler-${i}`), ctx)).toBe(true);
    }

    expect(cap.goals.trackedKeys()).toHaveLength(MAX_TRACKED_GOALS);
    expect(cap.goals.cursorFor(SESSION, 'goal-long-running')).not.toBeNull();
    expect(cap.goals.cursorFor(SESSION, 'goal-went-quiet')).toBeNull();
  });

  it(`keeps at most ${MAX_TASKS_PER_GOAL} tasks and says when it truncated`, () => {
    const { ctx, dispatch } = harness();
    const tasks = Array.from({ length: MAX_TASKS_PER_GOAL + 10 }, (_, i) => ({
      task_id: `task-${i}`,
      status: 'blocked',
    }));
    const event = { ...examplePayload('event', 'goal_snapshot'), goal: { tasks } };

    expect(validateEvent(event).valid).toBe(true);
    expect(dispatch(event, ctx)).toBe(true);

    const frame = ctx.frames[0].data as GoalSnapshotFrame;
    expect(frame.taskCount).toBe(MAX_TASKS_PER_GOAL);
    expect(frame.tasks).toHaveLength(MAX_TASKS_PER_GOAL);
    // Truncation that is not reported would show an incomplete goal as complete.
    expect(frame.tasksTruncated).toBe(true);
    expect(ctx.warns.join(' ')).toContain('truncated');
  });

  /**
   * `depends_on` had no cap while its sibling `tasks` did, for the same stated
   * reason ("copying an unbounded array into long-lived state is the leak").
   * Both the retained record AND the frame that crosses the IPC boundary were
   * sized by the engine: 64 goals x 256 tasks x unbounded.
   */
  it(`keeps at most ${MAX_DEPENDS_ON_PER_TASK} dependencies per task and says when it truncated`, () => {
    const { cap, ctx, dispatch } = harness();
    const dependsOn = Array.from({ length: 50_000 }, (_, i) => `dep-${i}`);
    const event = {
      ...examplePayload('event', 'goal_snapshot'),
      goal: { tasks: [{ task_id: 'task-publish', status: 'blocked', depends_on: dependsOn }] },
    };

    expect(validateEvent(event).valid).toBe(true);
    expect(dispatch(event, ctx)).toBe(true);

    const frame = ctx.frames[0].data as GoalSnapshotFrame;
    expect(frame.tasks[0].dependsOn).toHaveLength(MAX_DEPENDS_ON_PER_TASK);
    expect(frame.dependsOnTruncated).toBe(true);
    // The retained copy is the one that outlives the frame, so it is asserted too.
    expect(cap.goals.recordFor(SESSION, GOAL)?.tasks?.[0].depends_on).toHaveLength(MAX_DEPENDS_ON_PER_TASK);
    expect(ctx.warns.join(' ')).toContain('dependencies');
  });

  /**
   * A count cap alone still leaves the product unbounded - the engine controls
   * the STRINGS too, and one 10 MB objective is the same class of leak as one
   * unbounded array. Prose and identifiers get different caps because
   * identifiers are the ones multiplied by the task and dependency caps.
   */
  it('clamps an over-long objective and reports the clamp instead of showing it whole', () => {
    const { cap, ctx, dispatch } = harness();
    const objective = 'o'.repeat(MAX_GOAL_TEXT + 1_000);
    const event = { ...examplePayload('event', 'goal_snapshot'), goal: { objective } };

    expect(validateEvent(event).valid).toBe(true);
    expect(dispatch(event, ctx)).toBe(true);

    const frame = ctx.frames[0].data as GoalSnapshotFrame;
    expect(frame.objective).toHaveLength(MAX_GOAL_TEXT);
    expect(frame.textClamped).toBe(true);
    expect(cap.goals.objectiveFor(SESSION, GOAL)).toHaveLength(MAX_GOAL_TEXT);
    expect(ctx.warns.join(' ')).toContain('clamped');
  });

  it(`clamps engine identifiers at ${MAX_GOAL_ID_TEXT} characters, the engine's own id ceiling`, () => {
    const { cap, ctx, dispatch } = harness();
    const event = {
      ...examplePayload('event', 'goal_snapshot'),
      goal: {
        lifecycle: { state: 's'.repeat(MAX_GOAL_ID_TEXT + 5) },
        tasks: [{ task_id: 't'.repeat(MAX_GOAL_ID_TEXT + 5), depends_on: ['d'.repeat(MAX_GOAL_ID_TEXT + 5)] }],
      },
    };

    expect(validateEvent(event).valid).toBe(true);
    expect(dispatch(event, ctx)).toBe(true);

    const frame = ctx.frames[0].data as GoalSnapshotFrame;
    expect(frame.tasks[0].taskId).toHaveLength(MAX_GOAL_ID_TEXT);
    expect(frame.tasks[0].dependsOn?.[0]).toHaveLength(MAX_GOAL_ID_TEXT);
    expect(frame.lifecycleState).toHaveLength(MAX_GOAL_ID_TEXT);
    expect(frame.textClamped).toBe(true);
    expect(cap.goals.lifecycleStateFor(SESSION, GOAL)).toHaveLength(MAX_GOAL_ID_TEXT);
  });

  /**
   * `state_digest` and `transition` are the two engine strings the REDUCER
   * retains - they are a goal's identity under one cursor - and they are decoded
   * by the handler rather than by the record decoder, which is how they would
   * escape the cap the record fields get.
   */
  it.each([
    ['goal_snapshot', 'state_digest', (frame: GoalSnapshotFrame) => frame.stateDigest],
    ['goal_transition', 'transition', (frame: GoalTransitionFrame) => frame.transition],
  ])('clamps the retained identity string on %s', (type, field, read) => {
    const { ctx, dispatch } = harness();
    const event = { ...examplePayload('event', type), [field]: 'x'.repeat(MAX_GOAL_TEXT + 10) };

    expect(validateEvent(event).valid).toBe(true);
    expect(dispatch(event, ctx)).toBe(true);

    const frame = ctx.frames[0].data as GoalSnapshotFrame & GoalTransitionFrame;
    expect(read(frame)).toHaveLength(MAX_GOAL_TEXT);
    expect(frame.textClamped).toBe(true);
    expect(ctx.warns.join(' ')).toContain('clamped');
  });

  /**
   * The one string that must NOT be clamped: a cursor is echoed back verbatim,
   * so a shortened digest would be a command carrying a cursor the engine never
   * published. Over the bound it is refused like any other unusable cursor and
   * the last complete one is kept.
   */
  it('refuses an over-long cursor digest rather than clamping one onto a command', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(snapshotWith(cursorOf(40, 'digest-40'), 'state-a'), ctx)).toBe(true);

    const huge = 'd'.repeat(MAX_CURSOR_DIGEST_TEXT + 1);
    const event = snapshotWith(cursorOf(41, huge), 'state-b');
    expect(validateEvent(event).valid).toBe(true);
    expect(dispatch(event, ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalSnapshotFrame;
    expect(frame.verdict).toBe('uncursored');
    expect(
      unwrap(buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL })).cursor
    ).toEqual({ journal_digest: 'digest-40', journal_sequence: 40 });
  });

  it(`remembers at most ${MAX_RECENT_GOAL_REQUESTS} sent commands`, () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    for (let i = 0; i < MAX_RECENT_GOAL_REQUESTS + 5; i += 1) {
      const outcome = sendGoalCommand(
        ctx,
        cap.goals,
        buildGoalResync(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }),
        () => true
      );
      expect(outcome.ok).toBe(true);
    }

    expect(cap.goals.recentRequestIds()).toHaveLength(MAX_RECENT_GOAL_REQUESTS);
  });
});

/**
 * Guards that survived the first mutation sweep, now driven.
 *
 * Each of these is a single condition in the reducer or the decoder that no
 * assertion reached: deleting it left the suite green, which makes it
 * decoration a refactor can drop in good conscience. They are kept rather than
 * deleted - each states something the schema permits and the wire really does -
 * so each gets the test that fails without it.
 */
describe('the absent-field guards, each with the test that kills it', () => {
  /**
   * `objective` is absent from a snapshot's record whenever the engine chooses
   * not to repeat it - every field under `goal` is optional and nothing in the
   * contract says an absent field is a retracted one. Overwriting with
   * `undefined` would blank an objective the engine never withdrew.
   */
  it('keeps the objective when a later snapshot carries a record without one', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(snapshotWith(cursorOf(40, 'digest-40'), 'state-a'), ctx)).toBe(true);
    expect(cap.goals.objectiveFor(SESSION, GOAL)).toBe('ship the release candidate');

    const later = { ...snapshotWith(cursorOf(41, 'digest-41'), 'state-b'), goal: { lifecycle: { state: 'running' } } };
    expect(validateEvent(later).valid).toBe(true);
    expect(dispatch(later, ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalSnapshotFrame;
    expect(frame.adopted).toBe(true);
    // The frame shows what THIS event carried; the registry keeps what the
    // engine last said. Both are asserted so neither can drift into the other.
    expect(frame.objective).toBeUndefined();
    expect(cap.goals.objectiveFor(SESSION, GOAL)).toBe('ship the release candidate');
  });

  /**
   * The same guard on the other field, reached by the other event.
   * `goal_transition` requires `lifecycle` but nothing inside it, so
   * `lifecycle: {}` is a legal payload - and it must not blank a state the
   * engine reported one event ago.
   */
  it('keeps the lifecycle state when a transition carries an empty lifecycle object', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);
    expect(cap.goals.lifecycleStateFor(SESSION, GOAL)).toBe('running');

    const transition = {
      ...examplePayload('event', 'goal_transition'),
      cursor: cursorOf(41, 'digest-41'),
      lifecycle: {},
    };
    expect(validateEvent(transition).valid).toBe(true);
    expect(dispatch(transition, ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalTransitionFrame;
    expect(frame.adopted).toBe(true);
    expect(frame.lifecycleState).toBeUndefined();
    expect(cap.goals.lifecycleStateFor(SESSION, GOAL)).toBe('running');
  });

  /**
   * `depends_on` is typed `items: {type: string}`, so a non-string entry is a
   * payload the engine should never send - which is exactly why the decoder
   * must not forward it. The renderer would render `null` as a dependency.
   */
  it('drops non-string depends_on entries instead of forwarding them to the renderer', () => {
    const { cap, ctx, dispatch } = harness();
    const event = {
      ...examplePayload('event', 'goal_snapshot'),
      goal: { tasks: [{ task_id: 'task-publish', depends_on: ['task-build', 7, null, { task: 'x' }] }] },
    };

    // MEASURED, and it is the reason this guard is not decoration: the schema
    // ACCEPTS this. `tasks.items` is an `anyOf` of two shapes, and the completed
    // -task branch declares no `depends_on` at all while being
    // `additionalProperties: true` - so a `depends_on` of any item type
    // satisfies that branch. Nothing upstream of this decoder rejects it.
    expect(validateEvent(event).valid).toBe(true);
    expect(dispatch(event, ctx)).toBe(true);

    expect((ctx.frames[0].data as GoalSnapshotFrame).tasks[0].dependsOn).toEqual(['task-build']);
    expect(cap.goals.recordFor(SESSION, GOAL)?.tasks?.[0].depends_on).toEqual(['task-build']);
  });
});

/**
 * `adversarial/recovery/version-mismatch.jsonl` - the fifth fixture, borrowed
 * for a different question than the other four.
 *
 * It re-publishes one cursor with a BUMPED `recovery_version`. The goal-shaped
 * analogue is a `goal_version` bump at one cursor, and it separates two rules
 * that could easily be confused: the cursor rules treat a re-announced cursor
 * with the same state as `unchanged` (no state change), while `goal_version` is
 * echoed from the newest event whatever the cursor verdict was. A host that only
 * updated the version on an adopted observation would send a stale one for as
 * long as the goal sat at one cursor.
 */
describe('version-mismatch: a version bump at one cursor is echoed, not treated as a contradiction', () => {
  it('keeps the cursor unchanged and still echoes the newer goal_version', () => {
    const [snapshot] = readFixture('adversarial/recovery/version-mismatch.jsonl');
    expect(snapshot.recovery_version).toBe(2);
    const cursor = snapshot.cursor as Record<string, unknown>;

    const { cap, ctx, dispatch } = harness();
    const first = { ...snapshotWith(cursor, 'state-a'), goal_version: 1 };
    const bumped = { ...snapshotWith(cursor, 'state-a'), goal_version: Number(snapshot.recovery_version) };
    expect(validateEvent(first).valid).toBe(true);
    expect(validateEvent(bumped).valid).toBe(true);

    expect(dispatch(first, ctx)).toBe(true);
    expect(dispatch(bumped, ctx)).toBe(true);

    const frame = ctx.frames.at(-1)?.data as GoalSnapshotFrame;
    expect(frame.verdict).toBe('unchanged');
    expect(frame.needsResync).toBe(false);
    expect(cap.goals.goalVersionFor(SESSION, GOAL)).toBe(2);
    expect(
      unwrap(buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL })).goal_version
    ).toBe(2);
  });
});

describe('the send path', () => {
  it('writes a well-formed command when the engine is reachable', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    const outcome = sendGoalCommand(
      ctx,
      cap.goals,
      buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }),
      () => true
    );

    expect(outcome.ok).toBe(true);
    expect(ctx.sent).toHaveLength(1);
    expect(validateCommand(ctx.sent[0]).valid).toBe(true);
    expect(cap.goals.recentRequestIds()).toHaveLength(1);
  });

  /**
   * `sendCommand` returns void and the agent behind it drops the write in
   * silence when the engine's stdin is gone. A discarded `goal_advance` looks
   * exactly like a goal that stopped moving, so the probe is required and its
   * answer is honoured before anything is recorded.
   */
  it('sends nothing and records nothing when the engine is unreachable', () => {
    const { cap, ctx, dispatch } = harness();
    expect(dispatch(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    const outcome = sendGoalCommand(
      ctx,
      cap.goals,
      buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }),
      () => false
    );

    expect(outcome.ok).toBe(false);
    expect(ctx.sent).toEqual([]);
    expect(cap.goals.recentRequestIds()).toEqual([]);
    expect(ctx.warns.join(' ')).toContain('cannot be reached');
  });

  it('reports a write that threw after the probe said yes, and records nothing', () => {
    const cap = createDurableGoalsCapability();
    const ctx = makeContext({ throwOnSend: true });
    expect(createDispatcher([cap])(examplePayload('event', 'goal_snapshot'), ctx)).toBe(true);

    const outcome = sendGoalCommand(
      ctx,
      cap.goals,
      buildGoalAdvance(cap.goals, availableContract(), { sessionId: SESSION, goalId: GOAL }),
      () => true
    );

    expect(outcome.ok).toBe(false);
    expect(cap.goals.recentRequestIds()).toEqual([]);
    expect(ctx.warns.join(' ')).toContain('failed to reach the engine');
  });
});
