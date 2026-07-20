/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RRULE recurrence expansion for the Calendar feature, built on dayjs (no new
 * dependency - the `rrule` npm package cannot be installed on this machine).
 *
 * Recurrence is stored as a standard iCal RRULE string in the event's `rrule`
 * column, so a future upgrade to the real `rrule` library is a drop-in swap. We
 * support the subset the UI exposes: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL,
 * BYDAY (weekly, incl. the "weekdays" preset MO,TU,WE,TH,FR), COUNT, and UNTIL.
 *
 * All arithmetic runs in the host's local zone (matching NoteReminderScanner's
 * local Date math and the "every Monday means my Monday" user expectation).
 * Timezone-per-event is deferred; events store absolute UTC epoch-ms.
 */

import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import weekday from 'dayjs/plugin/weekday';
import utc from 'dayjs/plugin/utc';
import duration from 'dayjs/plugin/duration';
import type { CalendarEvent, CalendarOccurrence } from '@/common/types/calendar';

dayjs.extend(isoWeek);
dayjs.extend(weekday);
dayjs.extend(utc);
dayjs.extend(duration);

// secondary: per-occurrence recurrence exceptions (EXDATE / edit-this-occurrence)
// are deferred - every occurrence currently inherits the series row verbatim.

/** Cap on materialized in-window occurrences (port of `_RRULE_EXPANSION_LIMIT`). */
export const RRULE_EXPANSION_LIMIT = 1000;

/** Hard guard against a pathological generation loop (DAILY over ~270 years). */
const MAX_ITERATIONS = 100_000;

type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

type ParsedRule = {
  freq: Freq;
  interval: number;
  /** ISO weekday numbers (Mon=1..Sun=7), ascending; empty when no BYDAY. */
  byday: number[];
  count?: number;
  /** UNTIL as inclusive epoch-ms, or undefined. */
  untilMs?: number;
};

const ISO_BY_TOKEN: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
const DAYJS_UNIT: Record<Freq, dayjs.ManipulateType> = {
  DAILY: 'day',
  WEEKLY: 'week',
  MONTHLY: 'month',
  YEARLY: 'year',
};

/** Parse an iCal UNTIL value (`YYYYMMDD`, `YYYYMMDDTHHMMSS`, or `...Z`) to epoch-ms. */
function parseUntil(raw: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
  if (!m) return undefined;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const yy = Number(y);
  const mon = Number(mo) - 1;
  const day = Number(d);
  if (hh === undefined) {
    // Date-only UNTIL is inclusive of the whole local day.
    return new Date(yy, mon, day, 23, 59, 59, 999).getTime();
  }
  const H = Number(hh);
  const M = Number(mm);
  const S = Number(ss);
  return z ? Date.UTC(yy, mon, day, H, M, S) : new Date(yy, mon, day, H, M, S).getTime();
}

/** Parse an RRULE string via a hand-rolled key=value splitter. Returns null if unusable. */
export function parseRRule(rrule: string | undefined): ParsedRule | null {
  if (!rrule || !rrule.trim()) return null;
  const parts = rrule
    .replace(/^RRULE:/i, '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  const map = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    map.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }
  const freqRaw = (map.get('FREQ') ?? '').toUpperCase();
  if (freqRaw !== 'DAILY' && freqRaw !== 'WEEKLY' && freqRaw !== 'MONTHLY' && freqRaw !== 'YEARLY') {
    return null;
  }
  const intervalRaw = Number(map.get('INTERVAL'));
  const interval = Number.isInteger(intervalRaw) && intervalRaw > 0 ? intervalRaw : 1;
  const byday = (map.get('BYDAY') ?? '')
    .split(',')
    .map((tok) => ISO_BY_TOKEN[tok.trim().toUpperCase()])
    .filter((n): n is number => typeof n === 'number')
    .toSorted((a, b) => a - b);
  const countRaw = Number(map.get('COUNT'));
  const count = Number.isInteger(countRaw) && countRaw > 0 ? countRaw : undefined;
  const untilRaw = map.get('UNTIL');
  const untilMs = untilRaw ? parseUntil(untilRaw) : undefined;
  return { freq: freqRaw as Freq, interval, byday, count, untilMs };
}

/**
 * Generate occurrence START timestamps (ascending) from the series start up to
 * `stopAtStartExclusiveMs`, honouring COUNT (counted from the series beginning)
 * and UNTIL. Weekly BYDAY emits each listed weekday within every active week.
 */
function generateStarts(event: CalendarEvent, rule: ParsedRule, stopAtStartExclusiveMs: number): number[] {
  const starts: number[] = [];
  const baseMs = event.startMs;
  const countLimit = rule.count ?? Infinity;
  const untilMs = rule.untilMs ?? Infinity;
  let generated = 0;

  if (rule.freq === 'WEEKLY' && rule.byday.length > 0) {
    // Monday of the base week, preserving the base time-of-day.
    const mondayAtTime = dayjs(baseMs).subtract(dayjs(baseMs).isoWeekday() - 1, 'day');
    for (let k = 0; k < MAX_ITERATIONS; k += 1) {
      const weekStart = mondayAtTime.add(k * rule.interval, 'week');
      for (const iso of rule.byday) {
        const candMs = weekStart.add(iso - 1, 'day').valueOf();
        if (candMs < baseMs) continue; // before the series start
        if (generated >= countLimit || candMs > untilMs) return starts;
        generated += 1;
        if (candMs >= stopAtStartExclusiveMs) return starts;
        starts.push(candMs);
      }
      if (weekStart.valueOf() >= stopAtStartExclusiveMs) break;
    }
    return starts;
  }

  const unit = DAYJS_UNIT[rule.freq];
  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    const curMs = dayjs(baseMs)
      .add(i * rule.interval, unit)
      .valueOf();
    if (generated >= countLimit || curMs > untilMs) break;
    generated += 1;
    if (curMs >= stopAtStartExclusiveMs) break;
    starts.push(curMs);
  }
  return starts;
}

/** Build one occurrence from a series event and a concrete occurrence window. */
function makeOccurrence(
  event: CalendarEvent,
  occurrenceStartMs: number,
  occurrenceEndMs: number,
  isRecurring: boolean
): CalendarOccurrence {
  return {
    ...event,
    seriesId: event.id,
    occurrenceStartMs,
    occurrenceEndMs,
    isRecurring,
  };
}

/**
 * Expand an event into the occurrences overlapping `[rangeStartMs, rangeEndMs)`.
 *
 * Overlap test (port of calendar_routes.py:548): an occurrence is kept iff
 * `occEndMs > rangeStartMs && occStartMs < rangeEndMs`. A non-recurring event
 * yields a single occurrence iff it overlaps the range. Recurring expansion is
 * capped at {@link RRULE_EXPANSION_LIMIT} in-window occurrences.
 */
export function expandRange(event: CalendarEvent, rangeStartMs: number, rangeEndMs: number): CalendarOccurrence[] {
  const durationMs = Math.max(0, event.endMs - event.startMs);
  const rule = parseRRule(event.rrule);

  if (!rule) {
    // Non-recurring (or unparseable RRULE): a single occurrence iff it overlaps.
    if (event.endMs > rangeStartMs && event.startMs < rangeEndMs) {
      return [makeOccurrence(event, event.startMs, event.endMs, false)];
    }
    return [];
  }

  const results: CalendarOccurrence[] = [];
  for (const s of generateStarts(event, rule, rangeEndMs)) {
    const occEnd = s + durationMs;
    if (occEnd <= rangeStartMs) continue; // ends before the window opens
    if (s >= rangeEndMs) continue; // defensive - generateStarts already excludes
    results.push(makeOccurrence(event, s, occEnd, true));
    if (results.length >= RRULE_EXPANSION_LIMIT) break;
  }
  return results;
}

/**
 * The start of the most recent occurrence whose reminder instant
 * (`occurrenceStart - reminderLeadMs`) is at or before `nowMs`, or null when no
 * occurrence is due yet. Drives {@link CalendarReminderScanner}'s next-instant
 * computation for both one-off and recurring events.
 */
export function lastReminderOccurrence(event: CalendarEvent, nowMs: number): number | null {
  const lead = event.reminderLeadMs ?? 0;
  // An occurrence is "due" once its start is within `lead` of now.
  const thresholdMs = nowMs + lead;
  const rule = parseRRule(event.rrule);

  if (!rule) {
    return event.startMs <= thresholdMs ? event.startMs : null;
  }

  const starts = generateStarts(event, rule, thresholdMs + 1);
  return starts.length > 0 ? starts[starts.length - 1] : null;
}
