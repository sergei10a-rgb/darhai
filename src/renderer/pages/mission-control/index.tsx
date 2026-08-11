/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Tabs } from '@arco-design/web-react';
import { Clock, Gauge, RefreshCw, Target, Users } from 'lucide-react';
import { useDurableGoals, useMissionControl } from './useMissionControl';
import type { DurableGoalView, DurableGoalsState } from './useMissionControl';
import { CostTab } from './cost/CostTab';
import PageShell from '@/renderer/components/layout/PageShell';
import type { LedgerCounts, LedgerEntry, LedgerStatus } from '@/common/types/missionControl';
import type { GoalTaskSummary } from '@process/agent/wcore/capabilities/handlers/durableGoals';
import styles from './MissionControl.module.css';

/** Accent color per normalized status (drives the CSS --accent var). */
const STATUS_ACCENT: Record<LedgerStatus, string> = {
  running: '#ff6b35',
  verifying: '#b07bff',
  failed: '#ff4d4f',
  zombie: '#c0392b',
  blocked: '#ff9f43',
  pending: '#5b8def',
  done: '#2ec27e',
  idle: '#7a818c',
};

/** Statuses that get a pulsing dot (live work). */
const LIVE_STATUS = new Set<LedgerStatus>(['running', 'verifying', 'failed']);

const STAT_ORDER: LedgerStatus[] = ['running', 'verifying', 'pending', 'blocked', 'failed', 'zombie', 'done', 'idle'];

/** Urgency sections, rendered top-to-bottom; empty ones are skipped. */
const SECTIONS: Array<{ key: string; statuses: LedgerStatus[]; accent: string }> = [
  { key: 'attention', statuses: ['failed', 'zombie', 'blocked'], accent: STATUS_ACCENT.failed },
  { key: 'active', statuses: ['running'], accent: STATUS_ACCENT.running },
  { key: 'verifying', statuses: ['verifying'], accent: STATUS_ACCENT.verifying },
  { key: 'scheduled', statuses: ['pending'], accent: STATUS_ACCENT.pending },
  { key: 'done', statuses: ['done'], accent: STATUS_ACCENT.done },
  { key: 'idle', statuses: ['idle'], accent: STATUS_ACCENT.idle },
];

/** Tween a number from its previous value to the target with an ease-out curve. */
function useCountUp(target: number, durationMs = 700): number {
  const [val, setVal] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    let raf = 0;
    let startTs = 0;
    const tick = (now: number) => {
      if (!startTs) startTs = now;
      const p = Math.min(1, (now - startTs) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      const next = Math.round(from + (target - from) * eased);
      setVal(next);
      fromRef.current = next;
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return val;
}

function relTime(ms: number | undefined): string | null {
  if (!ms) return null;
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60_000) return 'just now';
  const mins = Math.round(abs / 60_000);
  const hrs = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const unit = mins < 60 ? `${mins}m` : hrs < 24 ? `${hrs}h` : `${days}d`;
  return diff < 0 ? `${unit} ago` : `in ${unit}`;
}

const StatTile: React.FC<{ status: LedgerStatus; count: number }> = ({ status, count }) => {
  const { t } = useTranslation();
  // Guard against a partial/stale snapshot omitting a bucket: a missing count
  // must render as 0, never NaN (which `useCountUp`'s tween would otherwise show).
  const safeCount = Number.isFinite(count) ? count : 0;
  const shown = useCountUp(safeCount);
  return (
    <div
      className={`${styles.statTile} ${safeCount === 0 ? styles.zero : ''}`}
      style={{ '--accent': STATUS_ACCENT[status] } as React.CSSProperties}
    >
      <span className={styles.statNum}>{shown}</span>
      <span className={styles.statLabel}>{t(`missionControl.status.${status}`)}</span>
    </div>
  );
};

const Row: React.FC<{ entry: LedgerEntry; index: number }> = ({ entry, index }) => {
  const { t } = useTranslation();
  const accent = STATUS_ACCENT[entry.status];
  const live = LIVE_STATUS.has(entry.status);
  const subtitle = [entry.context, entry.detail].filter(Boolean).join(' · ');
  const next = entry.source === 'cron' ? relTime(entry.nextRunAtMs) : null;
  const heartbeat = entry.lastHeartbeat ? relTime(entry.lastHeartbeat) : null;
  const retries =
    entry.retryBudget != null && entry.retriesUsed != null
      ? t('missionControl.meta.retries', { used: entry.retriesUsed, total: entry.retryBudget })
      : null;
  const verdict =
    entry.verdict === 'pass'
      ? t('missionControl.meta.verdictPass')
      : entry.verdict === 'fail'
        ? t('missionControl.meta.verdictFail')
        : null;
  // Zombie rows surface staleness via the last heartbeat; otherwise prefer next-run (cron) then updated.
  const metaTime =
    entry.status === 'zombie' && heartbeat
      ? t('missionControl.meta.heartbeat', { time: heartbeat })
      : next
        ? t('missionControl.meta.nextRun', { time: next })
        : heartbeat
          ? t('missionControl.meta.heartbeat', { time: heartbeat })
          : t('missionControl.meta.updated', { time: relTime(entry.updatedAt) ?? '' });

  return (
    <div
      className={styles.row}
      style={{ '--accent': accent, animationDelay: `${Math.min(index, 12) * 32}ms` } as React.CSSProperties}
    >
      <span className={`${styles.dot} ${live ? styles.dotLive : ''}`} />
      <div className={styles.main}>
        <span className={styles.rowTitle}>{entry.title}</span>
        {subtitle ? <span className={styles.rowSub}>{subtitle}</span> : null}
      </div>
      <span className={styles.pill} style={{ '--accent': accent } as React.CSSProperties}>
        {t(`missionControl.status.${entry.status}`)}
      </span>
      {entry.needsHuman ? <span className={styles.needsHuman}>{t('missionControl.meta.needsHuman')}</span> : null}
      <div className={styles.meta}>
        <span className={styles.sourceChip}>
          {entry.source === 'cron' ? <Clock size={12} /> : <Users size={12} />}
          {t(`missionControl.source.${entry.source}`)}
        </span>
        {verdict ? <span className={styles.metaTime}>{verdict}</span> : null}
        {retries ? <span className={styles.metaTime}>{retries}</span> : null}
        <span className={styles.metaTime}>{metaTime}</span>
      </div>
    </div>
  );
};

const Section: React.FC<{ label: string; accent: string; entries: LedgerEntry[] }> = ({ label, accent, entries }) => {
  if (entries.length === 0) return null;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionDot} style={{ '--accent': accent } as React.CSSProperties} />
        <span className={styles.sectionLabel}>{label}</span>
        <span className={styles.sectionCount}>{entries.length}</span>
      </div>
      <div className={styles.list}>
        {entries.map((entry, i) => (
          <Row key={entry.id} entry={entry} index={i} />
        ))}
      </div>
    </div>
  );
};

const OperationsView: React.FC = () => {
  const { t } = useTranslation();
  const { snapshot, loading, refresh } = useMissionControl();
  const entries = snapshot?.entries ?? [];
  const counts: LedgerCounts = snapshot?.counts ?? {
    running: 0,
    verifying: 0,
    pending: 0,
    blocked: 0,
    failed: 0,
    zombie: 0,
    done: 0,
    idle: 0,
    total: 0,
  };

  return (
    <>
      <div className={styles.opsToolbar}>
        <span className={styles.live}>
          <span className={styles.liveDot} />
          {t('missionControl.live')}
        </span>
        <Button size='small' icon={<RefreshCw size={14} />} loading={loading} onClick={() => void refresh()}>
          {t('missionControl.refresh')}
        </Button>
      </div>

      <div className={styles.statRow}>
        {STAT_ORDER.map((status) => (
          <StatTile key={status} status={status} count={counts[status]} />
        ))}
      </div>

      {entries.length === 0 ? (
        <div className={styles.empty}>
          <Gauge size={40} className={styles.emptyRadar} />
          <span className={styles.emptyTitle}>{t('missionControl.empty')}</span>
          <span className={styles.emptyHint}>{t('missionControl.emptyHint')}</span>
        </div>
      ) : (
        SECTIONS.map((section) => (
          <Section
            key={section.key}
            label={t(`missionControl.section.${section.key}`)}
            accent={section.accent}
            entries={entries.filter((e) => section.statuses.includes(e.status))}
          />
        ))
      )}
    </>
  );
};

/**
 * An engine timestamp, in the language the app is set to.
 *
 * The locale is passed explicitly. A bare `toLocaleString()` formats in the
 * OPERATING SYSTEM's locale, so a user who set Darhai to Mongolian on an en-US
 * Windows install reads a lease deadline in a different convention than every
 * label beside it - on the one surface where the deadline is the point.
 *
 * Absolute rather than relative on purpose: a lease expiry is a deadline, and
 * "in 2m" read at the wrong moment is a different claim than the instant the
 * engine actually named.
 */
function formatWhen(ms: number, locale: string): string {
  return new Date(ms).toLocaleString(locale);
}

/**
 * The engine grades this capability with one of four strings; each means a
 * different thing to a user, so each gets its own sentence. A grade outside the
 * set is reported as itself rather than guessed at.
 */
const EXPLAINED_GRADES: ReadonlySet<string> = new Set(['publication_bound', 'shape_only', 'unavailable']);

/** One `label: value` fact about a goal. Rendered only when the value is known. */
const Fact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <span className={styles.fact}>
    <span className={styles.factLabel}>{label}</span>
    <span className={styles.factValue}>{value}</span>
  </span>
);

const TaskRow: React.FC<{ task: GoalTaskSummary }> = ({ task }) => {
  const { t } = useTranslation();
  // Every field of a task summary is optional on the wire, and a task the
  // engine did not grade is not a task with zero attempts. `unknown` says which
  // it is; `0` would read as a measurement.
  const unknown = t('missionControl.goals.unknown');
  return (
    <div className={styles.taskRow}>
      <span className={styles.taskId}>{task.taskId ?? unknown}</span>
      <span className={styles.taskCell}>{task.status ?? unknown}</span>
      <span className={styles.taskCell}>{task.attempts ?? unknown}</span>
      <span className={styles.taskCell}>{task.dependsOn?.length ? task.dependsOn.join(', ') : '—'}</span>
      <span className={styles.taskCell}>{task.outcomeState ?? '—'}</span>
    </div>
  );
};

const GoalCard: React.FC<{ goal: DurableGoalView }> = ({ goal }) => {
  const { t, i18n } = useTranslation();
  const iterations =
    goal.iterationsStarted !== undefined
      ? goal.iterationCeiling !== undefined
        ? t('missionControl.goals.iterationsOf', { started: goal.iterationsStarted, ceiling: goal.iterationCeiling })
        : t('missionControl.goals.iterationsCeilingUnknown', { started: goal.iterationsStarted })
      : null;

  return (
    <div
      className={`${styles.goalCard} ${goal.refusal ? styles.goalRefused : goal.needsResync ? styles.goalLocked : ''}`}
    >
      <div className={styles.goalHead}>
        <span className={styles.goalObjective}>{goal.objective ?? t('missionControl.goals.objectiveUnknown')}</span>
        <span className={styles.goalId}>{goal.goalId}</span>
      </div>

      <div className={styles.factRow}>
        {goal.lifecycleState ? <Fact label={t('missionControl.goals.stateLabel')} value={goal.lifecycleState} /> : null}
        {iterations ? <Fact label={t('missionControl.goals.iterationsLabel')} value={iterations} /> : null}
        {goal.taskCount !== undefined ? (
          <Fact label={t('missionControl.goals.tasksLabel')} value={String(goal.taskCount)} />
        ) : null}
        {goal.lastTransition ? (
          <Fact label={t('missionControl.goals.transitionLabel')} value={goal.lastTransition} />
        ) : null}
        {goal.loopOwnerLeaseExpiresUnixMs !== undefined ? (
          <Fact
            label={t('missionControl.goals.leaseLabel')}
            value={formatWhen(goal.loopOwnerLeaseExpiresUnixMs, i18n.language)}
          />
        ) : null}
        <Fact label={t('missionControl.goals.sessionLabel')} value={goal.sessionId} />
        <Fact label={t('missionControl.goals.seenLabel')} value={formatWhen(goal.seenAt, i18n.language)} />
      </div>

      {goal.refusal ? (
        <Alert
          type='error'
          title={t('missionControl.goals.refusedTitle')}
          content={
            <div className={styles.bannerBody}>
              <span>{t('missionControl.goals.refusedReason', { reason: goal.refusal.reason })}</span>
              {goal.refusal.refusedCommand ? (
                <span>{t('missionControl.goals.refusedCommand', { command: goal.refusal.refusedCommand })}</span>
              ) : null}
              {goal.refusal.correlationMismatch ? <span>{t('missionControl.goals.refusedMismatch')}</span> : null}
              <span className={styles.bannerDetail}>{goal.refusal.detail}</span>
            </div>
          }
        />
      ) : null}

      {goal.needsResync ? (
        <Alert
          type='warning'
          title={t('missionControl.goals.lockedTitle')}
          content={t('missionControl.goals.lockedBody')}
        />
      ) : null}

      {!goal.lastAdopted && goal.lastVerdict !== 'unchanged' && goal.lastVerdict !== 'refused' ? (
        <Alert
          type='warning'
          title={t('missionControl.goals.notAdoptedTitle', { verdict: goal.lastVerdict })}
          content={goal.lastDetail}
        />
      ) : null}

      {goal.tasks.length > 0 ? (
        <div className={styles.taskTable}>
          <div className={`${styles.taskRow} ${styles.taskHead}`}>
            <span className={styles.taskId}>{t('missionControl.goals.taskHeadId')}</span>
            <span className={styles.taskCell}>{t('missionControl.goals.taskHeadStatus')}</span>
            <span className={styles.taskCell}>{t('missionControl.goals.taskHeadAttempts')}</span>
            <span className={styles.taskCell}>{t('missionControl.goals.taskHeadDependsOn')}</span>
            <span className={styles.taskCell}>{t('missionControl.goals.taskHeadOutcome')}</span>
          </div>
          {goal.tasks.map((task, i) => (
            <TaskRow key={task.taskId ?? `task-${i}`} task={task} />
          ))}
        </div>
      ) : goal.taskCount === 0 ? (
        <span className={styles.goalNote}>{t('missionControl.goals.noTasks')}</span>
      ) : null}

      {goal.tasksTruncated ? <span className={styles.goalNote}>{t('missionControl.goals.tasksTruncated')}</span> : null}
      {goal.dependsOnTruncated ? (
        <span className={styles.goalNote}>{t('missionControl.goals.dependsOnTruncated')}</span>
      ) : null}
      {goal.textClamped ? <span className={styles.goalNote}>{t('missionControl.goals.textClamped')}</span> : null}
    </div>
  );
};

/** Exported for the DOM test, which drives it with real capability frames. */
export const GoalsView: React.FC<{ state: DurableGoalsState }> = ({ state }) => {
  const { t } = useTranslation();
  const { goals, availability } = state;
  // `null` covers BOTH honest non-degraded readings - "the engine graded this
  // available" and "no engine has spoken yet" - and neither may render a
  // banner. The grade string itself is carried through so the banner can state
  // what the engine actually said instead of a re-worded verdict.
  const grade = availability.state === 'degraded' ? availability.grade : null;
  const gradeKey = grade !== null && EXPLAINED_GRADES.has(grade) ? grade : 'unrecognised';
  // Three claims, not two. `unavailable` is the engine saying it does not carry
  // this capability, and only then may the hint say so. Every other degraded
  // grade means the capability EXISTS and may not publish here - telling that
  // user their build "does not report durable goals" contradicts the banner
  // three lines above, which was careful to name which grade the engine gave.
  const emptyHintKey =
    grade === null
      ? 'missionControl.goals.emptyHint'
      : grade === 'unavailable'
        ? 'missionControl.goals.emptyHintUnavailable'
        : 'missionControl.goals.emptyHintLimited';

  return (
    <>
      {/* The five control verbs live in the main process and no IPC verb exposes
          them, so this pane can explain a goal but not steer one. Saying so beats
          rendering an Advance button that would do nothing. */}
      <Alert type='info' content={t('missionControl.goals.readOnlyNote')} />

      {grade !== null ? (
        <Alert
          // `unavailable` is the end of the road; the other grades mean the
          // capability exists but will not publish here, which is a warning.
          type={grade === 'unavailable' ? 'error' : 'warning'}
          title={
            grade === 'unavailable'
              ? t('missionControl.goals.unavailableTitle')
              : t('missionControl.goals.limitedTitle')
          }
          content={
            <div className={styles.bannerBody}>
              <span>{t('missionControl.goals.gradeReported', { grade })}</span>
              <span>{t(`missionControl.goals.gradeExplained.${gradeKey}`)}</span>
            </div>
          }
        />
      ) : null}

      {state.evicted ? <span className={styles.goalNote}>{t('missionControl.goals.evicted')}</span> : null}

      {goals.length === 0 ? (
        <div className={styles.empty}>
          <Target size={40} className={styles.emptyRadar} />
          <span className={styles.emptyTitle}>{t('missionControl.goals.emptyTitle')}</span>
          <span className={styles.emptyHint}>{t(emptyHintKey)}</span>
        </div>
      ) : (
        <div className={styles.goalList}>
          {goals.map((goal) => (
            <GoalCard key={goal.key} goal={goal} />
          ))}
        </div>
      )}
    </>
  );
};

const MissionControlPage: React.FC = () => {
  const { t } = useTranslation();
  // Subscribed at the page, not inside the pane: Arco mounts a tab pane only
  // once it is opened, and a goal frame that arrives while the user is on
  // Operations must not be the one frame this surface never sees.
  const goalsState = useDurableGoals();

  return (
    <PageShell
      title={t('missionControl.pageTitle')}
      icon={<Gauge size={20} />}
      subtitle={t('missionControl.description')}
      width='full'
    >
      <Tabs defaultActiveTab='operations' className={styles.tabs}>
        <Tabs.TabPane key='operations' title={t('missionControl.tabs.operations')}>
          <OperationsView />
        </Tabs.TabPane>
        <Tabs.TabPane
          key='goals'
          // The counted label is one translatable unit, not a concatenation:
          // only the locale can decide the separator, the order, and - by adding
          // `goalsWithCount_one` / `_few` / ... beside it - the plural form.
          title={
            goalsState.goals.length > 0
              ? t('missionControl.tabs.goalsWithCount', { count: goalsState.goals.length })
              : t('missionControl.tabs.goals')
          }
        >
          <GoalsView state={goalsState} />
        </Tabs.TabPane>
        <Tabs.TabPane key='cost' title={t('missionControl.tabs.cost')}>
          <CostTab />
        </Tabs.TabPane>
      </Tabs>
    </PageShell>
  );
};

export default MissionControlPage;
