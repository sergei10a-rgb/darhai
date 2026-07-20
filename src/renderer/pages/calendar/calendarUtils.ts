/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure, i18n-agnostic helpers shared across the calendar surface: RRULE preset
 * mapping, reminder-lead options, color keys, and day/time formatting. Kept free
 * of React / Arco so it can be unit-tested and reused by every calendar view.
 */

/** Recurrence presets the composer exposes (map 1:1 to an RRULE string). */
export type RecurrencePreset = 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'yearly';

export const RECURRENCE_PRESETS: RecurrencePreset[] = ['none', 'daily', 'weekly', 'weekdays', 'monthly', 'yearly'];

/** Selectable event color token keys (mirror the Notes palette). */
export const COLOR_KEYS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

/** Reminder lead options; `ms: null` means "no reminder". */
export type ReminderOption = { key: string; ms: number | null };
export const REMINDER_OPTIONS: ReminderOption[] = [
  { key: 'none', ms: null },
  { key: 'atTime', ms: 0 },
  { key: 'min5', ms: 5 * 60_000 },
  { key: 'min10', ms: 10 * 60_000 },
  { key: 'min15', ms: 15 * 60_000 },
  { key: 'min30', ms: 30 * 60_000 },
  { key: 'hour1', ms: 60 * 60_000 },
  { key: 'hour2', ms: 2 * 60 * 60_000 },
  { key: 'day1', ms: 24 * 60 * 60_000 },
];

const ISO_WEEKDAY_TOKENS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

/** Build an iCal RRULE string from a preset. Weekly binds to the start weekday. */
export function presetToRrule(preset: RecurrencePreset, startMs: number): string | undefined {
  switch (preset) {
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${ISO_WEEKDAY_TOKENS[new Date(startMs).getDay()]}`;
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'monthly':
      return 'FREQ=MONTHLY';
    case 'yearly':
      return 'FREQ=YEARLY';
    default:
      return undefined;
  }
}

/** Recover the nearest matching preset from an RRULE string (for the edit form). */
export function rruleToPreset(rrule: string | undefined): RecurrencePreset {
  if (!rrule) return 'none';
  const u = rrule.toUpperCase();
  if (u.includes('FREQ=DAILY')) return 'daily';
  if (u.includes('FREQ=WEEKLY')) {
    return u.includes('BYDAY=MO,TU,WE,TH,FR') ? 'weekdays' : 'weekly';
  }
  if (u.includes('FREQ=MONTHLY')) return 'monthly';
  if (u.includes('FREQ=YEARLY')) return 'yearly';
  return 'none';
}

/** Map a reminder lead (ms | undefined) back to its option key for the form. */
export function reminderKeyFromMs(ms: number | undefined): string {
  if (ms === undefined) return 'none';
  const match = REMINDER_OPTIONS.find((o) => o.ms === ms);
  return match ? match.key : 'none';
}

/** Stable per-day bucket key (local calendar day) for grouping occurrences. */
export function dayKey(year: number, monthZeroBased: number, day: number): string {
  return `${year}-${monthZeroBased}-${day}`;
}

/** Local `HH:MM` time of an epoch-ms. */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Local `Mon D` date of an epoch-ms. */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', weekday: 'short' });
}
