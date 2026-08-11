/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import type { IWcoreCapabilitySnapshot } from '@/common/adapter/ipcBridge';
import type { MissionControlSnapshot } from '@/common/types/missionControl';
import type {
  GoalControlRefusedFrame,
  GoalSnapshotFrame,
  GoalTaskSummary,
  GoalTransitionFrame,
} from '@process/agent/wcore/capabilities/handlers/durableGoals';

/**
 * Loads the Mission Control snapshot and keeps it live: a short poll catches the
 * transient durable-execution states (verifying / zombie / freshly-failed) that
 * persist for less than a Watchdog interval, and team + cron events refetch
 * immediately on a known change so the user is not waiting on the poll.
 */
export function useMissionControl() {
  const { user } = useAuth();
  const userId = user?.id ?? 'system_default_user';

  const { data, isLoading, mutate } = useSWR<MissionControlSnapshot>(
    `mission-control/${userId}`,
    (): Promise<MissionControlSnapshot> => ipcBridge.missionControl.snapshot.invoke({ userId }),
    { revalidateOnFocus: true, refreshInterval: 5000 }
  );

  useEffect(() => {
    const refresh = (): void => {
      void mutate();
    };
    const offs = [
      // Team task lifecycle is driven by agent activity; these fire on the
      // transitions that move tasks between running / verifying / zombie / done.
      ipcBridge.team.agentStatusChanged.on(refresh),
      ipcBridge.team.listChanged.on(refresh),
      ipcBridge.cron.onJobExecuted.on(refresh),
      ipcBridge.cron.onJobUpdated.on(refresh),
      ipcBridge.cron.onJobCreated.on(refresh),
    ];
    return () => offs.forEach((off) => off());
  }, [mutate]);

  return { snapshot: data, loading: isLoading, refresh: mutate };
}

// ============================================
// Durable goals
// ============================================

/**
 * The capability id the engine grades in `ready.contract.capabilities`.
 *
 * ONLY there. It is NOT a name the engine uses in `capability_activation`
 * frames: those announce the engine's own INTERNAL subsystems (cooldown_tracker,
 * smart_handoff, ...), a namespace with zero overlap with the contract's
 * capability ids - pinned by the disjointness test in
 * `tests/unit/wcore-engineCapabilitySnapshot.test.ts`. A readout that waited for
 * an activation frame named `durable_goals_v1` waited forever, which is the
 * defect `ipcBridge.wcoreEngine.capabilitySnapshot` was added to close.
 *
 * A literal rather than an import of `DURABLE_GOALS_CAPABILITY`: that constant
 * lives in a main-process module, and importing a VALUE from `@process` pulls
 * main-process code into the renderer bundle. The type imports above are erased
 * at compile time, so they cost nothing; this string would not be.
 */
export const DURABLE_GOALS_CAPABILITY_ID = 'durable_goals_v1';

/**
 * How many goals this view keeps.
 *
 * Mirrors `MAX_TRACKED_GOALS` in the main-process registry (64), which is the
 * real ceiling: the host stops tracking past it, so a 65th goal could never
 * produce a frame anyway. Without a cap here a renderer that stays open for
 * days accumulates a card per goal the engine ever mentioned.
 */
export const MAX_SHOWN_GOALS = 64;

/** One goal as this view holds it. Every optional field is genuinely unknown. */
export type DurableGoalView = {
  /** `sessionId` + `goalId`: a goal id is only unique inside its session. */
  key: string;
  sessionId: string;
  goalId: string;
  goalVersion: number;
  /** Only a snapshot carries the objective; a transition never does. */
  objective?: string;
  lifecycleState?: string;
  iterationCeiling?: number;
  iterationsStarted?: number;
  loopOwnerEpoch?: number;
  loopOwnerLeaseExpiresUnixMs?: number;
  /**
   * How many tasks the ENGINE reported, which may exceed `tasks.length`: the
   * host keeps at most `MAX_TASKS_PER_GOAL` of them and says so via
   * {@link DurableGoalView.tasksTruncated}. Undefined until a snapshot arrives -
   * a transition says nothing about tasks - and undefined again when the
   * snapshot that arrived omitted the `tasks` array, which the schema allows.
   * `0` is only ever the engine's own count, never this view's default.
   */
  taskCount?: number;
  tasks: GoalTaskSummary[];
  /** The engine reported more tasks than the host retains; the list is cut. */
  tasksTruncated: boolean;
  /** Some task listed more dependencies than the host retains. */
  dependsOnTruncated: boolean;
  /** Some engine string was longer than its cap and is shown cut to it. */
  textClamped: boolean;
  /** The last `transition` string the engine published, verbatim. */
  lastTransition?: string;
  /** A `goal_resync` is owed before the engine will accept a control command. */
  needsResync: boolean;
  /** The host's cursor verdict on the most recent frame for this goal. */
  lastVerdict: string;
  /** False when the host refused the last frame (stale replay, conflict, ...). */
  lastAdopted: boolean;
  /** The host's own sentence about that verdict. Shown verbatim. */
  lastDetail: string;
  /** When this renderer saw the last frame. Not an engine timestamp. */
  seenAt: number;
  /** The last refusal the engine sent for this goal, if any. */
  refusal?: GoalRefusalView;
};

/** A `goal_control_refused` frame, plus when this view saw it. */
export type GoalRefusalView = Omit<GoalControlRefusedFrame, 'sessionId' | 'goalId' | 'goalVersion'> & {
  seenAt: number;
};

/**
 * What this host can honestly say about the capability itself.
 *
 * `unknown` is the starting point and stays that way until an engine has
 * published a `ready`. It is NOT "working" and it is NOT "broken": before the
 * first engine speaks, the host holds no grade at all, and a surface that
 * rendered either verdict would be inventing the one fact it exists to report.
 *
 * `degraded` carries the engine's own grade string rather than a re-worded
 * verdict, because the four grades are not interchangeable: `publication_bound`
 * means the shape is settled but emission is conditional, `shape_only` means
 * the behaviour does not exist yet, `unavailable` means not in this build.
 */
export type GoalsAvailability = { state: 'unknown' } | { state: 'available' } | { state: 'degraded'; grade: string };

export type DurableGoalsState = {
  goals: DurableGoalView[];
  availability: GoalsAvailability;
  /** True once a goal was dropped to stay under {@link MAX_SHOWN_GOALS}. */
  evicted: boolean;
};

/** IPC hands us `unknown`; a frame is only usable once its envelope is proven. */
function goalEnvelope(data: unknown): { sessionId: string; goalId: string; goalVersion: number } | null {
  if (typeof data !== 'object' || data === null) return null;
  const frame = data as Partial<GoalSnapshotFrame>;
  if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) return null;
  if (typeof frame.goalId !== 'string' || frame.goalId.length === 0) return null;
  if (typeof frame.goalVersion !== 'number') return null;
  return { sessionId: frame.sessionId, goalId: frame.goalId, goalVersion: frame.goalVersion };
}

/**
 * Whether the payload of an observation frame may be believed as CURRENT state.
 *
 * `seeded` and `advanced` are the verdicts the host adopted. `unchanged` is
 * documented as a benign replay of the state already held - identical cursor,
 * identical identity - so its payload is the current state even though nothing
 * moved, and believing it is how this view fills in a goal that was already
 * running before Mission Control was opened. Every other verdict is one the
 * host REFUSED (stale replay, digest/state conflict, uncursored); rendering
 * those payloads as the goal's state would show the user something this host
 * explicitly declined to believe.
 */
function payloadIsCurrent(adopted: boolean, verdict: string): boolean {
  return adopted || verdict === 'unchanged';
}

/**
 * Newest first, so the goal that just moved is the one at the top.
 *
 * `toSorted` is STABLE, and that is what carries the tie: `seenAt` is a
 * millisecond clock, and a burst of frames delivered in one tick all carry the
 * SAME value, so the comparator returns 0 for every pair and the input order is
 * the output order. Callers must therefore hand the goal that just moved in
 * first - see the merge in {@link useDurableGoals} - or a same-millisecond
 * burst orders itself oldest-first and the eviction below drops the newest.
 */
function sortBySeen(goals: DurableGoalView[]): DurableGoalView[] {
  return goals.toSorted((a, b) => b.seenAt - a.seenAt);
}

function applySnapshot(prev: DurableGoalView | undefined, frame: GoalSnapshotFrame, seenAt: number): DurableGoalView {
  const base: DurableGoalView = prev ?? {
    key: `${frame.sessionId}::${frame.goalId}`,
    sessionId: frame.sessionId,
    goalId: frame.goalId,
    goalVersion: frame.goalVersion,
    tasks: [],
    tasksTruncated: false,
    dependsOnTruncated: false,
    textClamped: false,
    needsResync: false,
    lastVerdict: frame.verdict,
    lastAdopted: frame.adopted,
    lastDetail: frame.detail,
    seenAt,
  };

  const next: DurableGoalView = {
    ...base,
    goalVersion: frame.goalVersion,
    needsResync: frame.needsResync,
    lastVerdict: frame.verdict,
    lastAdopted: frame.adopted,
    lastDetail: frame.detail,
    seenAt,
  };

  if (!payloadIsCurrent(frame.adopted, frame.verdict)) return next;

  // Assigned one by one, not spread: an absent field on the wire means "the
  // engine did not report it", and copying `undefined` over a value learned
  // from an earlier snapshot would turn a silent field into a lost one.
  if (frame.objective !== undefined) next.objective = frame.objective;
  if (frame.lifecycleState !== undefined) next.lifecycleState = frame.lifecycleState;
  if (frame.iterationCeiling !== undefined) next.iterationCeiling = frame.iterationCeiling;
  if (frame.iterationsStarted !== undefined) next.iterationsStarted = frame.iterationsStarted;
  if (frame.loopOwnerEpoch !== undefined) next.loopOwnerEpoch = frame.loopOwnerEpoch;
  if (frame.loopOwnerLeaseExpiresUnixMs !== undefined) {
    next.loopOwnerLeaseExpiresUnixMs = frame.loopOwnerLeaseExpiresUnixMs;
  }
  // The count, the list and the two truncation notes are ONE reported fact -
  // the goal's task list - so they move together or not at all. An absent
  // `taskCount` means this snapshot carried no `tasks` array, and writing its
  // empty list plus `tasksTruncated: false` over what an earlier snapshot named
  // would erase tasks the engine never retracted and drop the note saying the
  // kept list is cut.
  if (frame.taskCount !== undefined) {
    next.taskCount = frame.taskCount;
    next.tasks = frame.tasks;
    next.tasksTruncated = frame.tasksTruncated;
    next.dependsOnTruncated = frame.dependsOnTruncated;
  }
  next.textClamped = frame.textClamped;
  return next;
}

function applyTransition(
  prev: DurableGoalView | undefined,
  frame: GoalTransitionFrame,
  seenAt: number
): DurableGoalView {
  const base: DurableGoalView = prev ?? {
    key: `${frame.sessionId}::${frame.goalId}`,
    sessionId: frame.sessionId,
    goalId: frame.goalId,
    goalVersion: frame.goalVersion,
    tasks: [],
    tasksTruncated: false,
    dependsOnTruncated: false,
    textClamped: false,
    needsResync: false,
    lastVerdict: frame.verdict,
    lastAdopted: frame.adopted,
    lastDetail: frame.detail,
    seenAt,
  };

  const next: DurableGoalView = {
    ...base,
    goalVersion: frame.goalVersion,
    needsResync: frame.needsResync,
    lastVerdict: frame.verdict,
    lastAdopted: frame.adopted,
    lastDetail: frame.detail,
    seenAt,
  };

  if (!payloadIsCurrent(frame.adopted, frame.verdict)) return next;
  next.lastTransition = frame.transition;
  if (frame.lifecycleState !== undefined) next.lifecycleState = frame.lifecycleState;
  if (frame.textClamped) next.textClamped = true;
  return next;
}

/**
 * A refusal names a goal this view may never have seen a snapshot for, and
 * dropping it on that ground would re-open the exact hole this capability was
 * built to close: `goal_control_refused` is graded `criticality: safety`, and a
 * refusal nobody shows is a goal that quietly stopped responding. So an unknown
 * goal gets a card with the little that is known - its id and the refusal.
 */
function applyRefusal(
  prev: DurableGoalView | undefined,
  frame: GoalControlRefusedFrame,
  seenAt: number
): DurableGoalView {
  const base: DurableGoalView = prev ?? {
    key: `${frame.sessionId}::${frame.goalId}`,
    sessionId: frame.sessionId,
    goalId: frame.goalId,
    goalVersion: frame.goalVersion,
    tasks: [],
    tasksTruncated: false,
    dependsOnTruncated: false,
    textClamped: false,
    needsResync: frame.needsResync,
    lastVerdict: 'refused',
    lastAdopted: false,
    lastDetail: frame.detail,
    seenAt,
  };

  const refusal: GoalRefusalView = {
    requestId: frame.requestId,
    reason: frame.reason,
    correlationMismatch: frame.correlationMismatch,
    needsResync: frame.needsResync,
    detail: frame.detail,
    seenAt,
  };
  if (frame.refusedCommand !== undefined) refusal.refusedCommand = frame.refusedCommand;

  return {
    ...base,
    goalVersion: frame.goalVersion,
    // `needsResync: false` on a refusal means the host held no cursor for this
    // goal, NOT that the goal is controllable - so a refusal never clears a
    // lock an earlier frame reported.
    needsResync: base.needsResync || frame.needsResync,
    seenAt,
    refusal,
  };
}

/**
 * Read the capability's availability out of the retained engine contract.
 *
 * Two distinct "empty" answers, and conflating them is the failure this branch
 * exists to avoid: `contractKnown: false` means no engine has published a
 * `ready` in this app run, so there is no grade to report; a KNOWN contract
 * that simply does not mention the capability is the engine saying it does not
 * have it, which the main process reads as `unavailable` (`gradeOf`) and this
 * matches so both sides give one answer.
 */
function readSnapshotAvailability(snapshot: IWcoreCapabilitySnapshot): GoalsAvailability {
  if (typeof snapshot !== 'object' || snapshot === null) return { state: 'unknown' };
  if (snapshot.contractKnown !== true) return { state: 'unknown' };
  // Typed `Record<string, string>`, so TypeScript calls this a `string` even
  // when the key is absent - this build has `strictNullChecks` off. The runtime
  // check is what decides, not the type.
  const graded = snapshot.grades?.[DURABLE_GOALS_CAPABILITY_ID];
  const grade = typeof graded === 'string' && graded.length > 0 ? graded : 'unavailable';
  if (grade === 'available') return { state: 'available' };
  return { state: 'degraded', grade };
}

/**
 * Durable goals as the engine reports them.
 *
 * READ-ONLY BY CONSTRUCTION. The five control verbs (`goal_open`,
 * `goal_declare_task`, `goal_advance`, `goal_cancel`, `goal_resync`) are built
 * and gated in the main process, and no IPC verb exposes them to the renderer,
 * so this view can watch a goal and explain a refusal but cannot send one. That
 * is why the surface states it instead of rendering buttons that would do
 * nothing.
 *
 * THE GOALS cannot be fetched and are not: a goal is journalled by the ENGINE,
 * and the host learns its state only from the frames the engine pushes. So this
 * subscribes and accumulates. A goal that was already running before Mission
 * Control was opened appears at its next snapshot or transition, not before -
 * which is why the empty state says so rather than claiming quiet.
 *
 * THE CAPABILITY'S GRADE is the opposite case and is pulled. It arrives once
 * per engine process on `ready` and the main process retains it, so a pane that
 * only listened would be reporting `unknown` for the whole app run - the engine
 * starts when the user opens a chat, which is precisely when this pane is not
 * mounted.
 */
export function useDurableGoals(): DurableGoalsState {
  const [state, setState] = useState<DurableGoalsState>({
    goals: [],
    availability: { state: 'unknown' },
    evicted: false,
  });
  /** Whether the last successful read found a contract. Drives the re-ask below. */
  const contractKnown = useRef(false);
  /**
   * Which grade pull is the newest. An answer from an older one is discarded.
   *
   * Two engine starts in quick succession issue two overlapping invokes, and
   * nothing in the IPC contract promises they resolve in the order they were
   * sent. Today's main handler answers synchronously inside its async wrapper,
   * so the inversion is not reachable - but the readout reports which engine is
   * running, and the day that provider gains an await (reading the contract off
   * disk, waiting on a spawning agent) the first engine's grade would silently
   * overwrite the second's with nothing to catch it.
   */
  const pullSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;

    /**
     * Pull the grade the main process retained.
     *
     * PULL, not subscribe. The contract arrives on `ready`, which happens when
     * the engine process starts - by definition while the user is in a chat and
     * this pane is unmounted. A surface built only on the live stream is empty
     * forever, no matter how correct its reducer is.
     */
    const readAvailability = (): void => {
      const seq = (pullSeq.current += 1);
      void ipcBridge.wcoreEngine.capabilitySnapshot
        .invoke()
        .then((snapshot) => {
          if (cancelled) return;
          // A newer pull was issued while this one was in flight, so this answer
          // describes an engine that has already been replaced. Last-to-resolve
          // must not beat last-to-be-asked.
          if (seq !== pullSeq.current) return;
          const availability = readSnapshotAvailability(snapshot);
          contractKnown.current = availability.state !== 'unknown';
          setState((prev) => ({ ...prev, availability }));
        })
        .catch(() => {
          // A failed IPC call is a fact about this call, not a verdict the
          // engine gave. Leaving the readout at its last honest value beats
          // turning a broken pipe into "the capability is unavailable".
        });
    };

    readAvailability();

    const off = ipcBridge.conversation.responseStream.on((message) => {
      // NOT the availability source - this frame names an engine-INTERNAL
      // subsystem, never a contract capability id. It is read for the one thing
      // it does prove: an engine process just started, so the retained contract
      // has just been replaced and the pulled grade is stale.
      if (message.type === 'capability_activation') {
        readAvailability();
        return;
      }

      if (
        message.type !== 'goal_snapshot' &&
        message.type !== 'goal_transition' &&
        message.type !== 'goal_control_refused'
      ) {
        return;
      }

      // A goal frame proves an engine is publishing. If the mount-time read
      // landed before that engine's `ready` was recorded, this is the only other
      // moment the renderer can learn the grade - so ask again until it does.
      if (contractKnown.current !== true) readAvailability();

      const envelope = goalEnvelope(message.data);
      if (!envelope) return;

      const seenAt = Date.now();
      const key = `${envelope.sessionId}::${envelope.goalId}`;

      setState((prev) => {
        const existing = prev.goals.find((goal) => goal.key === key);
        let updated: DurableGoalView;
        if (message.type === 'goal_snapshot') {
          updated = applySnapshot(existing, message.data as GoalSnapshotFrame, seenAt);
        } else if (message.type === 'goal_transition') {
          updated = applyTransition(existing, message.data as GoalTransitionFrame, seenAt);
        } else {
          updated = applyRefusal(existing, message.data as GoalControlRefusedFrame, seenAt);
        }

        // The goal that just moved goes FIRST, not last. `prev.goals` is already
        // newest-first and the sort is stable, so this is what decides the order
        // when every frame in a burst shares one millisecond: appended last, an
        // all-tie burst comes out oldest-first and `slice` then evicts the goal
        // that arrived most recently while the pane says older ones were dropped.
        const merged = sortBySeen([updated, ...prev.goals.filter((goal) => goal.key !== key)]);
        const kept = merged.slice(0, MAX_SHOWN_GOALS);
        return {
          ...prev,
          goals: kept,
          // Availability is never inferred from goal traffic: a frame proves
          // the engine published SOMETHING, not how the engine graded the
          // capability, and the grade is the fact this readout reports.
          evicted: prev.evicted || merged.length > kept.length,
        };
      });
    });

    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return state;
}
