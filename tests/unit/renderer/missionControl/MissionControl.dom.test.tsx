/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mission Control's durable-goals pane, driven by the frames the capability
 * actually emits.
 *
 * NOTHING HERE IS HAND-SHAPED. Every payload rendered below is produced by
 * running the REAL `durableGoalsCapability` handler over the engine's own
 * example payload from `tests/fixtures/engine-contract`, capturing what it
 * passes to `ctx.emit`, and pushing exactly that object onto the response
 * stream - the same path `WCoreManager` uses for capability frames. A test that
 * invented a `{ objective, tasks }` object would keep passing after the handler
 * changed shape, which is the one failure a rendering test exists to catch.
 *
 * THE AVAILABILITY READOUT IS HELD TO THE SAME RULE, and was not. It used to be
 * proved by a hand-written `{capability:'durable_goals_v1', health:'declined'}`
 * frame - a frame no engine can emit, because `capability_activation` names the
 * engine's INTERNAL subsystems and `durable_goals_v1` is a CONTRACT id. The
 * pane now reads `ipcBridge.wcoreEngine.capabilitySnapshot`, and the mock below
 * answers it with the REAL main-process assembly (`buildWcoreCapabilitySnapshot`)
 * over the real observed activation capture and the real `ready` fixture. The
 * old assertion is now unwritable: replaying the capture cannot produce an
 * "unavailable" readout, because no captured frame mentions this capability at
 * all - which is exactly why the shipped app never showed one.
 */

import { render, screen, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoist mocks ---
const { streamListeners, noopOff, snapshotSource, language } = vi.hoisted(() => ({
  streamListeners: { value: [] as Array<(m: unknown) => void> },
  noopOff: () => {},
  // Wired to the real main-process builder below, once imports have evaluated.
  snapshotSource: { read: (): unknown => undefined },
  language: { value: 'en-US' },
}));

// i18n: return the reference English string for the keys this pane uses, with
// {{...}} interpolation, so assertions read as copy rather than as key paths.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // `i18n.language` is the app's language, which is NOT the operating
    // system's - the distinction the pane's timestamps have to honour.
    i18n: { language: language.value },
    t: (key: string, opts?: Record<string, unknown>) => {
      const table: Record<string, string> = {
        'missionControl.goals.readOnlyNote': 'Read-only.',
        'missionControl.goals.emptyTitle': 'No goals reported',
        'missionControl.goals.emptyHint': 'A goal appears here the moment the engine publishes one.',
        'missionControl.goals.emptyHintUnavailable': 'This engine build does not report durable goals.',
        'missionControl.goals.unavailableTitle': 'Durable goals are unavailable',
        'missionControl.goals.limitedTitle': 'Durable goals are limited in this engine build',
        'missionControl.goals.gradeReported': 'The engine graded this capability {{grade}}.',
        'missionControl.goals.gradeExplained.publication_bound': 'Emission depends on how the engine is configured.',
        'missionControl.goals.gradeExplained.shape_only': 'The behaviour behind the type does not exist yet.',
        'missionControl.goals.gradeExplained.unavailable': 'This build does not carry durable goals at all.',
        'missionControl.goals.gradeExplained.unrecognised': 'This host does not know that grade.',
        'missionControl.goals.objectiveUnknown': 'Objective not reported',
        'missionControl.goals.stateLabel': 'State',
        'missionControl.goals.iterationsLabel': 'Iterations',
        'missionControl.goals.iterationsOf': '{{started}} of {{ceiling}}',
        'missionControl.goals.iterationsCeilingUnknown': '{{started}}, ceiling not reported',
        'missionControl.goals.tasksLabel': 'Tasks',
        'missionControl.goals.transitionLabel': 'Last transition',
        'missionControl.goals.leaseLabel': 'Loop lease expires',
        'missionControl.goals.sessionLabel': 'Session',
        'missionControl.goals.seenLabel': 'Last update seen',
        'missionControl.goals.refusedTitle': 'The engine refused a control command',
        'missionControl.goals.refusedReason': 'Reason: {{reason}}',
        'missionControl.goals.refusedCommand': 'Refused command: {{command}}',
        'missionControl.goals.refusedMismatch': 'This request id was sent for a different goal or session.',
        'missionControl.goals.lockedTitle': 'Control is locked until a resync',
        'missionControl.goals.lockedBody': 'Advancing or cancelling is refused until the engine republishes the goal.',
        'missionControl.goals.notAdoptedTitle': 'Not applied: {{verdict}}',
        'missionControl.goals.taskHeadId': 'Task',
        'missionControl.goals.taskHeadStatus': 'Status',
        'missionControl.goals.taskHeadAttempts': 'Attempts',
        'missionControl.goals.taskHeadDependsOn': 'Depends on',
        'missionControl.goals.taskHeadOutcome': 'Outcome',
        'missionControl.goals.noTasks': 'The engine reported no tasks for this goal.',
        'missionControl.goals.tasksTruncated': 'The engine reported more tasks than are kept.',
        'missionControl.goals.dependsOnTruncated': 'A task listed more dependencies than are kept.',
        'missionControl.goals.textClamped': 'The engine sent text longer than is kept.',
        'missionControl.goals.evicted': 'Older goals were dropped.',
        'missionControl.goals.unknown': 'unknown',
        'missionControl.tabs.operations': 'Operations',
        'missionControl.tabs.cost': 'Cost',
        'missionControl.tabs.goals': 'Goals',
        // Deliberately NOT "Goals · {{count}}": a locale must be able to move
        // the count, drop the separator and change the word order, and a label
        // built by concatenating `tabs.goals` with a hardcoded ` · ` can only
        // ever produce the English shape. This form is unreachable that way, so
        // the assertion below fails if the concatenation comes back.
        'missionControl.tabs.goalsWithCount': '{{count}} goals tracked',
        'missionControl.pageTitle': 'Mission Control',
        'missionControl.description': 'Mission Control',
      };
      let out = table[key] ?? key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return out;
    },
  }),
}));

vi.mock('../../../../src/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: {
        on: (handler: (m: unknown) => void) => {
          streamListeners.value.push(handler);
          return noopOff;
        },
      },
    },
    // The seam this pane's availability now comes from. Answered by the real
    // main-process builder, not by a fixture of what it might return.
    wcoreEngine: { capabilitySnapshot: { invoke: () => Promise.resolve(snapshotSource.read()) } },
    // Reached only by the Operations pane, which the tab-label test mounts.
    team: { agentStatusChanged: { on: () => noopOff }, listChanged: { on: () => noopOff } },
    cron: {
      onJobExecuted: { on: () => noopOff },
      onJobUpdated: { on: () => noopOff },
      onJobCreated: { on: () => noopOff },
    },
    missionControl: { snapshot: { invoke: () => Promise.resolve(undefined) } },
  },
}));

// The page's other panes are irrelevant to goals and drag in the router, SWR
// and the cost analytics graph. Stub them so this file loads the pane, not the app.
vi.mock('../../../../src/renderer/components/layout/PageShell', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../src/renderer/pages/mission-control/cost/CostTab', () => ({ CostTab: (): null => null }));
vi.mock('../../../../src/renderer/pages/mission-control/MissionControl.module.css', () => ({ default: {} }));
vi.mock('../../../../src/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'test-user' } }),
}));

import React from 'react';
import { createDispatcher } from '@process/agent/wcore/capabilities';
import { negotiateContract } from '@process/agent/wcore/capabilities/contractNegotiation';
import { recordEngineContract, resetEngineContract } from '@process/agent/wcore/capabilities/engineContractStore';
import {
  capabilityActivationCapability,
  resetCapabilityActivation,
} from '@process/agent/wcore/capabilities/handlers/capabilityActivation';
import {
  durableGoalsCapability,
  resetGoalState,
  MAX_TASKS_PER_GOAL,
  MAX_DEPENDS_ON_PER_TASK,
  MAX_GOAL_TEXT,
} from '@process/agent/wcore/capabilities/handlers/durableGoals';
import type { CapabilityContext } from '@process/agent/wcore/capabilities/types';
import { buildWcoreCapabilitySnapshot } from '@process/bridge/wcoreEngineBridge';
import { examplePayload, readFixture } from '../../../helpers/engineContract';
import {
  DURABLE_GOALS_CAPABILITY_ID,
  MAX_SHOWN_GOALS,
  useDurableGoals,
} from '../../../../src/renderer/pages/mission-control/useMissionControl';
import MissionControlPage, { GoalsView } from '../../../../src/renderer/pages/mission-control';

// The renderer's availability now comes from the same function the IPC handler
// calls. Nothing in between is re-implemented here.
snapshotSource.read = buildWcoreCapabilitySnapshot;

type Frame = { type: string; data: unknown; msg_id: string };

/** A context that records what the handler emits and swallows its logging. */
function recorder(): CapabilityContext & { frames: Frame[] } {
  const frames: Frame[] = [];
  return {
    frames,
    sendCommand: () => {},
    emit: (frame) => frames.push(frame),
    activeMsgId: () => '',
    log: () => {},
    warn: () => {},
  };
}

const dispatch = createDispatcher([durableGoalsCapability]);

/**
 * Run one engine event through the real capability and return what it emitted.
 *
 * This is the whole point of the file: the object handed to the renderer below
 * is the handler's own output, not a description of it.
 */
function emitFor(event: Record<string, unknown>): Frame {
  const ctx = recorder();
  const handled = dispatch(event, ctx);
  expect(handled).toBe(true);
  expect(ctx.frames).toHaveLength(1);
  return ctx.frames[0];
}

/**
 * Push a capability frame the way `WCoreManager` forwards one to the renderer.
 *
 * `async` because delivery can start a second state update the caller did not
 * ask for: while this host still holds no contract, a goal frame is proof an
 * engine is publishing, so the pane re-reads the grade. Awaiting the act scope
 * lets that land inside it instead of after the assertions.
 */
async function deliver(frame: Frame): Promise<void> {
  await act(async () => {
    for (const listener of streamListeners.value) {
      listener({ type: frame.type, data: frame.data, msg_id: frame.msg_id, conversation_id: 'conv-1' });
    }
  });
}

/**
 * Replay an engine process START into the main-process records the pane reads.
 *
 * `ready` first (that is where the contract is captured, per the `ready` arm in
 * `wcore/index.ts`), then the observed `capability_activation` capture through
 * the REAL activation handler. Both records are what
 * `buildWcoreCapabilitySnapshot` reads, so the pane sees an engine start, not a
 * description of one.
 */
function replayEngineStart(ready: Record<string, unknown>): void {
  recordEngineContract(negotiateContract(ready));
  const ctx = recorder();
  let handled = 0;
  for (const frame of readFixture('observed/capability_activation.default.jsonl')) {
    if (capabilityActivationCapability.handle(frame, ctx)) handled += 1;
  }
  expect(handled, 'no observed activation frame was handled - the capture or the handler changed').toBeGreaterThan(0);
}

/** The engine's own `ready`, which grades `durable_goals_v1` as `available`. */
function readyFixture(): Record<string, unknown> {
  return examplePayload('event', 'ready');
}

/** The capabilities block of that `ready`, as a plain object we can vary. */
function gradesOf(ready: Record<string, unknown>): Record<string, string> {
  const contract = ready.contract as { capabilities: Record<string, string> };
  return { ...contract.capabilities };
}

function readyGrading(grades: Record<string, string>): Record<string, unknown> {
  const ready = readyFixture();
  return { ...ready, contract: { ...(ready.contract as object), capabilities: grades } };
}

/**
 * The hook and the pane wired together, which is what a user actually meets.
 *
 * The page component itself is not mounted: it adds only the tab chrome around
 * this pair, and mounting it would make every assertion depend on the ledger
 * and cost tabs staying importable. (One test does mount it, for the one thing
 * that lives in the chrome: the counted tab label.)
 */
const GoalsHarness: React.FC = () => <GoalsView state={useDurableGoals()} />;

/**
 * Mount and let the pane's pull land.
 *
 * The grade is fetched over IPC, so it arrives a microtask after mount. A
 * synchronous `render` would assert on the frame before the answer exists.
 */
async function mountGoals(): Promise<void> {
  render(<GoalsHarness />);
  await act(async () => {});
}

describe('Mission Control - durable goals pane', () => {
  beforeEach(() => {
    streamListeners.value = [];
    language.value = 'en-US';
    resetGoalState();
    resetEngineContract();
    resetCapabilityActivation();
  });

  it('renders nothing-yet honestly before any goal frame arrives', async () => {
    await mountGoals();
    expect(screen.getByText('No goals reported')).toBeTruthy();
    // Not "all quiet": a goal opened before this pane was mounted is invisible
    // until the engine republishes it, and the hint has to say so.
    expect(screen.getByText('A goal appears here the moment the engine publishes one.')).toBeTruthy();
    // Read-only is stated up front, since there is no control verb to offer.
    expect(screen.getByText('Read-only.')).toBeTruthy();
    // No engine has published a `ready`, so this host holds NO grade. Reporting
    // either verdict here would invent the one fact the banner exists to state.
    expect(screen.queryByText('Durable goals are unavailable')).toBeNull();
    expect(screen.queryByText('This engine build does not report durable goals.')).toBeNull();
  });

  it('renders the objective, iteration budget and task list from a real goal_snapshot frame', async () => {
    await mountGoals();
    const frame = emitFor(examplePayload('event', 'goal_snapshot'));
    await deliver(frame);

    // Values from the contract fixture: objective, 3 of 8 iterations, 2 tasks.
    expect(screen.getByText('ship the release candidate')).toBeTruthy();
    expect(screen.getByText('3 of 8')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('task-publish')).toBeTruthy();
    expect(screen.getByText('completed_undelivered')).toBeTruthy();
    // `depends_on` is what makes the list a plan rather than a bag of rows:
    // `task-build` appears twice - once as a row, once as what blocks publish.
    expect(screen.getAllByText('task-build')).toHaveLength(2);
    // No control affordances: the renderer cannot send goal_advance/goal_cancel.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a task the engine did not grade as unknown, never as zero', async () => {
    await mountGoals();
    const snapshot = examplePayload('event', 'goal_snapshot');
    const goal = snapshot.goal as Record<string, unknown>;
    // A legal payload: nested goal objects are `additionalProperties: true`
    // with no `required` list, so a task may carry only its id.
    snapshot.goal = { ...goal, tasks: [{ task_id: 'task-bare' }] };
    await deliver(emitFor(snapshot));

    expect(screen.getByText('task-bare')).toBeTruthy();
    // Two unknowns: status and attempts. `0 attempts` would read as a measurement.
    expect(screen.getAllByText('unknown')).toHaveLength(2);
  });

  it('surfaces a refusal - the safety-class event - with the engine reason', async () => {
    await mountGoals();
    await deliver(emitFor(examplePayload('event', 'goal_snapshot')));
    await deliver(emitFor(examplePayload('event', 'goal_control_refused')));

    expect(screen.getByText('The engine refused a control command')).toBeTruthy();
    expect(screen.getByText('Reason: cursor_stale')).toBeTruthy();
    // The goal stays on screen: a refusal explains a goal, it does not erase it.
    expect(screen.getByText('ship the release candidate')).toBeTruthy();
  });

  it('does not adopt a payload the host refused as a stale replay', async () => {
    await mountGoals();
    const first = examplePayload('event', 'goal_snapshot');
    await deliver(emitFor(first));

    // Same goal, an OLDER journal position and a different objective. The host
    // grades this `stale_replay` and does not adopt it; rendering its objective
    // would show the user a state this host explicitly declined to believe.
    const stale = examplePayload('event', 'goal_snapshot');
    stale.cursor = { journal_digest: 'sha256:goalcursor', journal_sequence: 5 };
    stale.state_digest = 'sha256:older';
    stale.goal = { ...(stale.goal as Record<string, unknown>), objective: 'an older objective' };
    const staleFrame = emitFor(stale);
    expect((staleFrame.data as { adopted: boolean }).adopted).toBe(false);
    await deliver(staleFrame);

    expect(screen.getByText('ship the release candidate')).toBeTruthy();
    expect(screen.queryByText('an older objective')).toBeNull();
    expect(screen.getByText('Not applied: stale_replay')).toBeTruthy();
  });
});

/**
 * `goal_transition` - the third frame this capability emits, and the one no
 * rendering test drove. `applyTransition` is its own reducer with its own
 * currency guard and its own `textClamped` accumulation, so a field rename or a
 * dropped guard there is invisible to every snapshot-path test.
 */
describe('Mission Control - durable goals pane, transitions', () => {
  beforeEach(() => {
    streamListeners.value = [];
    language.value = 'en-US';
    resetGoalState();
    resetEngineContract();
    resetCapabilityActivation();
  });

  it('renders the transition the engine published, from the real goal_transition fixture', async () => {
    await mountGoals();
    await deliver(emitFor(examplePayload('event', 'goal_transition')));

    // The fixture's own values: transition `loop_owner_claimed`, lifecycle `running`.
    expect(screen.getByText('loop_owner_claimed')).toBeTruthy();
    expect(screen.getByText('Last transition')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
    // A transition says nothing about tasks, so no task count may be invented.
    expect(screen.queryByText('Tasks')).toBeNull();
  });

  it('does not let a refused transition overwrite the state it already showed', async () => {
    await mountGoals();
    await deliver(emitFor(examplePayload('event', 'goal_transition')));
    expect(screen.getByText('loop_owner_claimed')).toBeTruthy();

    // Same goal, an OLDER journal position, a different transition and a
    // different lifecycle state. The host grades this `stale_replay`; adopting
    // its payload would replace a live goal's state with a replayed one.
    const stale = examplePayload('event', 'goal_transition');
    stale.cursor = { journal_digest: 'sha256:goalcursor', journal_sequence: 4 };
    stale.transition = 'loop_owner_released';
    stale.lifecycle = { state: 'cancelled' };
    const staleFrame = emitFor(stale);
    expect((staleFrame.data as { adopted: boolean }).adopted).toBe(false);
    await deliver(staleFrame);

    expect(screen.getByText('loop_owner_claimed')).toBeTruthy();
    expect(screen.queryByText('loop_owner_released')).toBeNull();
    expect(screen.queryByText('cancelled')).toBeNull();
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('Not applied: stale_replay')).toBeTruthy();
  });

  it('says the engine text was cut when a transition arrives over the cap', async () => {
    await mountGoals();
    const long = examplePayload('event', 'goal_transition');
    long.transition = 'x'.repeat(MAX_GOAL_TEXT + 1);
    const frame = emitFor(long);
    expect((frame.data as { textClamped: boolean }).textClamped).toBe(true);
    await deliver(frame);

    // A clipped string shown without saying so reads as the engine's own word.
    expect(screen.getByText('The engine sent text longer than is kept.')).toBeTruthy();
  });
});

/**
 * The notes that qualify a rendered goal. Each says "what you see is cut", and
 * each was unasserted - so a goal shown short would have read as a short goal.
 */
describe('Mission Control - durable goals pane, truncation notes', () => {
  beforeEach(() => {
    streamListeners.value = [];
    language.value = 'en-US';
    resetGoalState();
    resetEngineContract();
    resetCapabilityActivation();
  });

  it('reports the number of tasks the ENGINE sent, not the number this host kept', async () => {
    await mountGoals();
    const reported = MAX_TASKS_PER_GOAL + 10;
    const snapshot = examplePayload('event', 'goal_snapshot');
    snapshot.goal = {
      ...(snapshot.goal as Record<string, unknown>),
      tasks: Array.from({ length: reported }, (_, i) => ({ task_id: `task-${i}`, status: 'blocked' })),
    };
    await deliver(emitFor(snapshot));

    // The count measures the GOAL. Rendering the retained list's length would
    // print the host's buffer ceiling and read as a measurement of the goal.
    expect(screen.getByText(String(reported))).toBeTruthy();
    expect(screen.queryByText(String(MAX_TASKS_PER_GOAL))).toBeNull();
    // ... and the list beside it says out loud that it is the cut-down view.
    expect(screen.getByText('The engine reported more tasks than are kept.')).toBeTruthy();
  });

  it('says when a task listed more dependencies than are kept', async () => {
    await mountGoals();
    const snapshot = examplePayload('event', 'goal_snapshot');
    snapshot.goal = {
      ...(snapshot.goal as Record<string, unknown>),
      tasks: [
        {
          task_id: 'task-publish',
          status: 'blocked',
          depends_on: Array.from({ length: MAX_DEPENDS_ON_PER_TASK + 1 }, (_, i) => `dep-${i}`),
        },
      ],
    };
    await deliver(emitFor(snapshot));

    expect(screen.getByText('A task listed more dependencies than are kept.')).toBeTruthy();
  });

  it('says when older goals were dropped to stay under the cap', async () => {
    await mountGoals();
    await act(async () => {
      for (let i = 0; i <= MAX_SHOWN_GOALS; i += 1) {
        const snapshot = examplePayload('event', 'goal_snapshot');
        snapshot.goal_id = `goal-${i}`;
        snapshot.goal = { ...(snapshot.goal as Record<string, unknown>), goal_id: `goal-${i}`, tasks: [] };
        snapshot.state_digest = `sha256:goalstate-${i}`;
        const frame = emitFor(snapshot);
        for (const listener of streamListeners.value) {
          listener({ type: frame.type, data: frame.data, msg_id: frame.msg_id, conversation_id: 'conv-1' });
        }
      }
    });

    // A list that silently stops at its cap claims the engine has 64 goals.
    expect(screen.getByText('Older goals were dropped.')).toBeTruthy();
  });
});

/**
 * Availability. The pane reads the engine's CONTRACT grade, pulled from the
 * main process, because the live `capability_activation` stream names a
 * different namespace entirely and arrives while this pane is unmounted.
 */
describe('Mission Control - durable goals availability', () => {
  beforeEach(() => {
    streamListeners.value = [];
    language.value = 'en-US';
    resetGoalState();
    resetEngineContract();
    resetCapabilityActivation();
  });

  it('reads the contract grade, which a replayed engine start never names in its activation frames', async () => {
    replayEngineStart(readyFixture());

    // THE MEASUREMENT behind this whole change: the engine announced its
    // readiness for eight subsystems and not one of them is this capability, so
    // a readout waiting for that name waits forever. The grade is the answer.
    const snapshot = buildWcoreCapabilitySnapshot();
    expect(snapshot.activation.length).toBeGreaterThan(0);
    expect(snapshot.activation.map((row) => row.capability)).not.toContain(DURABLE_GOALS_CAPABILITY_ID);
    expect(snapshot.grades[DURABLE_GOALS_CAPABILITY_ID]).toBe('available');

    await mountGoals();

    // Graded available: no banner, and the empty state keeps its honest hint.
    expect(screen.queryByText('Durable goals are unavailable')).toBeNull();
    expect(screen.queryByText('Durable goals are limited in this engine build')).toBeNull();
    expect(screen.getByText('A goal appears here the moment the engine publishes one.')).toBeTruthy();
  });

  it('reports the capability as unavailable when the engine contract omits it', async () => {
    // An engine build that does not carry this capability: the same `ready`
    // fixture, with this one id absent from the grades it publishes. The host's
    // own `gradeOf` reads an unmentioned capability as `unavailable`.
    const grades = gradesOf(readyFixture());
    delete grades[DURABLE_GOALS_CAPABILITY_ID];
    replayEngineStart(readyGrading(grades));

    await mountGoals();

    expect(screen.getByText('Durable goals are unavailable')).toBeTruthy();
    expect(screen.getByText('The engine graded this capability unavailable.')).toBeTruthy();
    expect(screen.getByText('This build does not carry durable goals at all.')).toBeTruthy();
    // The empty state must not read as "all quiet" once the engine has said no.
    expect(screen.getByText('This engine build does not report durable goals.')).toBeTruthy();
  });

  it('names the engine grade verbatim when the capability is graded but not available', async () => {
    // `shape_only` is not invented here: it is the grade this same fixture
    // gives `browser_events`. The four grades mean different things to a user,
    // so the banner states which one rather than flattening them to "off".
    const grades = gradesOf(readyFixture());
    const shapeOnly = grades.browser_events;
    expect(shapeOnly, 'the fixture no longer grades any capability shape_only').toBe('shape_only');
    grades[DURABLE_GOALS_CAPABILITY_ID] = shapeOnly;
    replayEngineStart(readyGrading(grades));

    await mountGoals();

    expect(screen.getByText('Durable goals are limited in this engine build')).toBeTruthy();
    expect(screen.getByText('The engine graded this capability shape_only.')).toBeTruthy();
    expect(screen.getByText('The behaviour behind the type does not exist yet.')).toBeTruthy();
    // `shape_only` is not `unavailable`, so the unavailable wording must not appear.
    expect(screen.queryByText('Durable goals are unavailable')).toBeNull();
  });

  /**
   * The defect, locked shut. This is the exact payload the deleted test wrote by
   * hand, and it is now inert: `capability_activation` is read as "an engine
   * started", never as the grade, so a frame carrying this name - which no
   * engine emits anyway - cannot drive the readout it used to certify.
   */
  it('does not take its verdict from a capability_activation frame naming the contract id', async () => {
    replayEngineStart(readyFixture());
    await mountGoals();

    await act(async () => {
      for (const listener of streamListeners.value) {
        listener({
          type: 'capability_activation',
          msg_id: '',
          conversation_id: 'conv-1',
          data: {
            capability: DURABLE_GOALS_CAPABILITY_ID,
            stage: 'unavailable',
            reason: 'disabled_by_config',
            health: 'declined',
            remedy: 'config',
          },
        });
      }
    });

    // The contract still grades it `available`, and the contract is the source.
    expect(screen.queryByText('Durable goals are unavailable')).toBeNull();
    expect(screen.getByText('A goal appears here the moment the engine publishes one.')).toBeTruthy();
  });

  it('re-reads the grade when a new engine start is announced', async () => {
    await mountGoals();
    expect(screen.queryByText('Durable goals are unavailable')).toBeNull();

    // A second engine process, graded differently. Its `capability_activation`
    // frames are not the value - they are the only signal the renderer gets
    // that the retained contract has just been replaced.
    const grades = gradesOf(readyFixture());
    delete grades[DURABLE_GOALS_CAPABILITY_ID];
    replayEngineStart(readyGrading(grades));

    await act(async () => {
      for (const listener of streamListeners.value) {
        listener({
          type: 'capability_activation',
          msg_id: '',
          conversation_id: 'conv-1',
          data: { capability: 'smart_handoff', stage: 'enabled', health: 'ok' },
        });
      }
    });

    expect(screen.getByText('Durable goals are unavailable')).toBeTruthy();
  });
});

describe('Mission Control - durable goals pane, locale', () => {
  beforeEach(() => {
    streamListeners.value = [];
    language.value = 'en-US';
    resetGoalState();
    resetEngineContract();
    resetCapabilityActivation();
  });

  /**
   * The lease is a deadline, and the surface exists to show it. A timestamp
   * formatted in the OPERATING SYSTEM's locale sits next to labels in the app's
   * language, so this asserts the two languages disagree - which they cannot do
   * if the locale is not passed through.
   */
  it('formats engine timestamps in the app language, not the operating system one', async () => {
    const lease = (
      (examplePayload('event', 'goal_snapshot').goal as Record<string, unknown>).loop_owner as Record<string, unknown>
    ).lease_expires_unix_ms as number;
    const frame = emitFor(examplePayload('event', 'goal_snapshot'));

    language.value = 'ja-JP';
    await mountGoals();
    await deliver(frame);
    const japanese = new Date(lease).toLocaleString('ja-JP');
    expect(screen.getByText(japanese)).toBeTruthy();
    cleanup();

    streamListeners.value = [];
    resetGoalState();
    language.value = 'en-US';
    await mountGoals();
    await deliver(emitFor(examplePayload('event', 'goal_snapshot')));
    const english = new Date(lease).toLocaleString('en-US');
    expect(english, 'these two locales format this instant identically here').not.toBe(japanese);
    expect(screen.getByText(english)).toBeTruthy();
  });
});

describe('Mission Control - goals tab label', () => {
  beforeEach(() => {
    streamListeners.value = [];
    language.value = 'en-US';
    resetGoalState();
    resetEngineContract();
    resetCapabilityActivation();
  });

  /**
   * The counted label is the one piece of this surface that lives in the page
   * chrome, so it needs the page. Built by interpolation, not concatenation: a
   * locale that cannot move the count cannot translate the label.
   */
  it('renders the counted tab label as one translated unit', async () => {
    render(<MissionControlPage />);
    await act(async () => {});
    expect(screen.getByText('Goals')).toBeTruthy();

    const first = examplePayload('event', 'goal_snapshot');
    await deliver(emitFor(first));
    const second = examplePayload('event', 'goal_snapshot');
    second.goal_id = 'goal-002';
    second.goal = { ...(second.goal as Record<string, unknown>), goal_id: 'goal-002' };
    second.state_digest = 'sha256:goalstate-002';
    await deliver(emitFor(second));

    // The count sits where the LOCALE put it, not where a template literal did.
    expect(screen.getByText('2 goals tracked')).toBeTruthy();
    expect(screen.queryByText('Goals · 2')).toBeNull();
  });
});
