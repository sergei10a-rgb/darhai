/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICronJob } from '@/common/adapter/ipcBridge';
import type { TFunction } from 'i18next';

// Every cron day-of-week token we can name as a single day, in both the named
// form (MON..SUN) and the numeric form (0-7, where both 0 and 7 are Sunday).
// Ranges and lists are deliberately absent: they are real schedules, but not
// ones the weekly preset can represent.
const WEEKDAY_BY_TOKEN: Record<string, string> = {
  MON: 'MON',
  TUE: 'TUE',
  WED: 'WED',
  THU: 'THU',
  FRI: 'FRI',
  SAT: 'SAT',
  SUN: 'SUN',
  '0': 'SUN',
  '1': 'MON',
  '2': 'TUE',
  '3': 'WED',
  '4': 'THU',
  '5': 'FRI',
  '6': 'SAT',
  '7': 'SUN',
};

const WEEKDAY_LABEL_KEY: Record<string, string> = {
  MON: 'monday',
  TUE: 'tuesday',
  WED: 'wednesday',
  THU: 'thursday',
  FRI: 'friday',
  SAT: 'saturday',
  SUN: 'sunday',
};

/**
 * Canonical weekday for a cron day-of-week token, or null when the token is a
 * range, a list, or anything else we cannot name as one day.
 *
 * Both the schedule label in the list and the edit dialog's frequency form go
 * through here. They used to carry separate tables, and the dialog's table was
 * missing the numeric form - so a routine the list described as "Weekly on
 * Wednesday" opened as "Daily 09:00" and saving rewrote it.
 */
export function normalizeWeekdayToken(token: string): string | null {
  return WEEKDAY_BY_TOKEN[(token ?? '').toUpperCase()] ?? null;
}

function formatTime(hour: string, minute: string): string {
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

function formatCronExpr(expr: string, t: TFunction): string | null {
  if (!expr) return t('cron.page.scheduleDesc.manual');

  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const normalizedDayOfWeek = dayOfWeek.toUpperCase();
  const normalizedDayOfMonth = dayOfMonth.toUpperCase();

  // Every hour: minute fixed, hour wildcard.
  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return t('cron.page.scheduleDesc.hourly');
  }

  // The remaining shapes need a concrete time of day.
  if (hour === '*' || minute === '*') return null;
  const time = formatTime(hour, minute);

  // Daily.
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return t('cron.page.scheduleDesc.dailyAt', { time });
  }

  // Weekdays (Monday through Friday), named or numeric range.
  if (dayOfMonth === '*' && month === '*' && (normalizedDayOfWeek === 'MON-FRI' || dayOfWeek === '1-5')) {
    return t('cron.page.scheduleDesc.weekdaysAt', { time });
  }

  // Weekly on a single named or numeric weekday.
  if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    const weekday = normalizeWeekdayToken(dayOfWeek);
    if (weekday) {
      const weekdayKey = WEEKDAY_LABEL_KEY[weekday];
      return t('cron.page.scheduleDesc.weeklyAt', {
        day: t(`cron.page.weekday.${weekdayKey}`),
        time,
      });
    }
    return null;
  }

  // Monthly schedules (no weekday constraint).
  if (month === '*' && dayOfWeek === '*') {
    if (normalizedDayOfMonth === 'L') {
      return t('cron.page.scheduleDesc.monthlyLastDayAt', { time });
    }
    if (/^\d{1,2}$/.test(dayOfMonth)) {
      return t('cron.page.scheduleDesc.monthlyOnDayAt', { day: dayOfMonth, time });
    }
  }

  return null;
}

export type CronFrequency = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';

export type ParsedCronExpr = { frequency: CronFrequency; time: string; weekday: string };

/** Shown when an expression carries no time of its own. */
const DEFAULT_PARSED: ParsedCronExpr = { frequency: 'custom', time: '09:00', weekday: 'MON' };

/**
 * Read a cron expression back into the edit dialog's frequency form - the
 * inverse of the expression that dialog builds when saving.
 *
 * Anything this cannot express as one of the presets returns `custom`, which
 * keeps the original expression in the custom field. That matters more than it
 * looks: the earlier version answered `daily 09:00` for those, so opening a
 * schedule it did not understand and pressing Save replaced it. Losing a
 * schedule the user set is worse than showing them raw cron.
 */
export function parseCronExpr(expr: string): ParsedCronExpr {
  if (!expr) return { ...DEFAULT_PARSED, frequency: 'manual' };

  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return DEFAULT_PARSED;

  const [min, hour, day, month, dow] = parts;

  // Hourly: 0 * * * *
  if (hour === '*' && min === '0' && day === '*' && month === '*' && dow === '*') {
    return { ...DEFAULT_PARSED, frequency: 'hourly' };
  }

  if (day !== '*' || month !== '*') return DEFAULT_PARSED;

  const hourNum = Number(hour);
  const minNum = Number(min);
  const isClockTime =
    Number.isInteger(hourNum) &&
    Number.isInteger(minNum) &&
    hourNum >= 0 &&
    hourNum <= 23 &&
    minNum >= 0 &&
    minNum <= 59;
  if (!isClockTime) return DEFAULT_PARSED;
  const time = formatTime(String(hourNum), String(minNum));

  // Weekdays, named or numeric - the same two spellings the schedule label
  // accepts.
  if (dow.toUpperCase() === 'MON-FRI' || dow === '1-5') {
    return { frequency: 'weekdays', time, weekday: 'MON' };
  }

  if (dow === '*') return { frequency: 'daily', time, weekday: 'MON' };

  const weekday = normalizeWeekdayToken(dow);
  return weekday ? { frequency: 'weekly', time, weekday } : DEFAULT_PARSED;
}

/**
 * Format schedule for display - use human-readable description
 */
export function formatSchedule(job: ICronJob, t: TFunction): string {
  if (job.schedule.kind === 'cron') {
    return formatCronExpr(job.schedule.expr, t) ?? job.schedule.description;
  }

  if (job.schedule.kind === 'every' && job.schedule.everyMs === 3600000) {
    return t('cron.page.scheduleDesc.hourly');
  }

  return job.schedule.description;
}

/**
 * Format next run time for display
 */
export function formatNextRun(nextRunAtMs?: number): string {
  if (!nextRunAtMs) return '-';
  const date = new Date(nextRunAtMs);
  return date.toLocaleString();
}

/**
 * Get job status flags
 */
export function getJobStatusFlags(job: ICronJob): { hasError: boolean; isPaused: boolean } {
  return {
    hasError: job.state.lastStatus === 'error',
    isPaused: !job.enabled,
  };
}
