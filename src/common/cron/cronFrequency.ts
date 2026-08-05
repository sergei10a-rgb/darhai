/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which schedules are too frequent to safely spawn a whole new conversation.
 *
 * A job in `new_conversation` mode creates a fresh conversation and a fresh
 * agent process on every fire. At `* * * * *` that is one per minute, forever:
 * unbounded history growth, unbounded agent spawns, and real money spent against
 * the user's provider account while they are asleep.
 *
 * Nothing stopped it. The overlap guard that would have caught a pile-up reads
 * `isConversationBusy(job.metadata.conversationId)`, and a `new_conversation`
 * job has no `metadata.conversationId` by design - so the check evaluated
 * against `undefined`, never tripped, and every fire went through.
 *
 * This is deliberately a warning gate, not a ban: someone who genuinely wants a
 * minute-by-minute agent can pass `allowHighFrequency`. The point is that they
 * have to mean it.
 *
 * Kept dependency-free so both the service and the renderer can ask the same
 * question and give the same answer.
 */

/**
 * Below this, a new-conversation schedule needs explicit opt-in.
 *
 * Fifteen minutes is not a magic number - it is the point where a full agent
 * turn (spawn, prompt, tools, teardown) stops being comfortably shorter than the
 * gap between fires, so runs can start overlapping rather than queueing.
 */
export const MIN_SAFE_NEW_CONVERSATION_INTERVAL_MS = 15 * 60 * 1000;

/** How often a schedule fires, in ms, or null when it cannot be determined. */
export function scheduleIntervalMs(expr: string | undefined | null): number | null {
  const raw = (expr ?? '').trim();
  if (!raw) return null;

  // `@every 30s` / `30s` style fixed intervals.
  const every = /^(?:@every\s+)?(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?|d|days?)$/i.exec(raw);
  if (every) {
    const value = Number(every[1]);
    const unit = every[2].toLowerCase();
    if (unit.startsWith('s')) return value * 1000;
    if (unit.startsWith('m')) return value * 60_000;
    if (unit.startsWith('h')) return value * 3_600_000;
    return value * 86_400_000;
  }

  const fields = raw.split(/\s+/);
  // 5-field (minute-precision) or 6-field (second-precision) cron.
  if (fields.length !== 5 && fields.length !== 6) return null;

  if (fields.length === 6) {
    const seconds = fields[0];
    // Any second field that is not a fixed value fires at least once a minute.
    if (seconds !== '0' && seconds !== '*/60') return secondFieldIntervalMs(seconds);
  }

  const minute = fields.at(-5) ?? '*';
  if (minute === '*') return 60_000;
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step) return Number(step[1]) * 60_000;
  // A list (`0,30`) fires more than once an hour; take the tightest plausible gap.
  if (minute.includes(',')) {
    const parts = minute
      .split(',')
      .map((p) => Number(p))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (parts.length >= 2) {
      let smallest = Infinity;
      for (let i = 1; i < parts.length; i++) smallest = Math.min(smallest, parts[i] - parts[i - 1]);
      return smallest * 60_000;
    }
  }
  // A single fixed minute fires hourly at most - the hour field decides the rest,
  // and anything hourly or slower is already above the threshold.
  return 3_600_000;
}

function secondFieldIntervalMs(seconds: string): number {
  if (seconds === '*') return 1000;
  const step = /^\*\/(\d+)$/.exec(seconds);
  if (step) return Number(step[1]) * 1000;
  return 60_000;
}

/**
 * The schedule shape the scheduler stores.
 *
 * Declared structurally rather than imported so this module stays free of
 * process-side types and both sides can use it.
 */
export type ScheduleLike =
  | { kind: 'at'; atMs?: number }
  | { kind: 'every'; everyMs?: number }
  | { kind: 'cron'; expr?: string };

/**
 * How often a stored schedule fires, in ms, or null when undeterminable.
 *
 * A one-shot `at` returns null: it fires once, so frequency does not apply and
 * treating it as "unknown" is what keeps it out of every gate below.
 */
export function scheduleLikeIntervalMs(schedule: ScheduleLike | undefined | null): number | null {
  if (!schedule) return null;
  if (schedule.kind === 'at') return null;
  if (schedule.kind === 'every') {
    return typeof schedule.everyMs === 'number' && schedule.everyMs > 0 ? schedule.everyMs : null;
  }
  return scheduleIntervalMs(schedule.expr);
}

/**
 * Whether this schedule + mode combination needs the user to opt in.
 *
 * Only `new_conversation` is gated. A job that posts into an existing
 * conversation is bounded by that conversation's busy state, so a fast schedule
 * there queues instead of multiplying.
 */
export function isNewConversationFootgun(
  schedule: ScheduleLike | string | undefined | null,
  executionMode: string | undefined
): boolean {
  if (executionMode !== 'new_conversation') return false;
  let interval: number | null;
  if (schedule == null) {
    interval = null;
  } else if (typeof schedule === 'string') {
    interval = scheduleIntervalMs(schedule);
  } else {
    interval = scheduleLikeIntervalMs(schedule);
  }
  if (interval === null) return false;
  return interval < MIN_SAFE_NEW_CONVERSATION_INTERVAL_MS;
}
