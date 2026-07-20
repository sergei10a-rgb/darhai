/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the dayjs-backed RRULE expansion (Odysseus "calendar"). Covers
 * the UI-exposed subset: FREQ, INTERVAL, BYDAY (incl. the weekdays preset),
 * COUNT, UNTIL; overnight/multi-day overlap; the 1000-occurrence cap; and the
 * empty-RRULE single-occurrence path. All times are built with local `Date` so
 * the expansion (which runs in local time) is timezone-agnostic under test.
 */

import { describe, it, expect } from 'vitest';
import {
  expandRange,
  parseRRule,
  lastReminderOccurrence,
  RRULE_EXPANSION_LIMIT,
} from '@process/services/calendar/recurrence';
import type { CalendarEvent } from '@/common/types/calendar';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Local wall-clock epoch-ms (keeps tests independent of the runner's zone). */
function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

function makeEvent(overrides: Partial<CalendarEvent>): CalendarEvent {
  const startMs = overrides.startMs ?? at(2026, 1, 5, 9); // Mon 2026-01-05 09:00
  return {
    id: 'evt_1',
    userId: 'user-1',
    title: 'Standup',
    startMs,
    endMs: overrides.endMs ?? startMs + HOUR,
    allDay: false,
    createdAtMs: startMs,
    updatedAtMs: startMs,
    ...overrides,
  };
}

describe('parseRRule', () => {
  it('parses FREQ, INTERVAL, BYDAY, COUNT, UNTIL', () => {
    const rule = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10');
    expect(rule).not.toBeNull();
    expect(rule?.freq).toBe('WEEKLY');
    expect(rule?.interval).toBe(2);
    expect(rule?.byday).toEqual([1, 3, 5]);
    expect(rule?.count).toBe(10);
  });

  it('returns null for a missing / unknown FREQ', () => {
    expect(parseRRule('')).toBeNull();
    expect(parseRRule(undefined)).toBeNull();
    expect(parseRRule('INTERVAL=2')).toBeNull();
    expect(parseRRule('FREQ=HOURLY')).toBeNull();
  });

  it('tolerates a leading RRULE: prefix and defaults INTERVAL to 1', () => {
    const rule = parseRRule('RRULE:FREQ=DAILY');
    expect(rule?.freq).toBe('DAILY');
    expect(rule?.interval).toBe(1);
  });
});

describe('expandRange - non-recurring', () => {
  it('returns a single occurrence when the event overlaps the range', () => {
    const event = makeEvent({});
    const occ = expandRange(event, at(2026, 1, 5, 0), at(2026, 1, 6, 0));
    expect(occ).toHaveLength(1);
    expect(occ[0].isRecurring).toBe(false);
    expect(occ[0].seriesId).toBe('evt_1');
    expect(occ[0].occurrenceStartMs).toBe(event.startMs);
    expect(occ[0].occurrenceEndMs).toBe(event.endMs);
  });

  it('returns nothing when the event does not overlap the range', () => {
    const event = makeEvent({});
    expect(expandRange(event, at(2026, 2, 1, 0), at(2026, 2, 2, 0))).toHaveLength(0);
  });

  it('includes an overnight event that starts before the window but ends inside it', () => {
    // 22:00 -> 06:00 next day.
    const event = makeEvent({ startMs: at(2026, 1, 10, 22), endMs: at(2026, 1, 11, 6) });
    const occ = expandRange(event, at(2026, 1, 11, 0), at(2026, 1, 12, 0));
    expect(occ).toHaveLength(1);
  });
});

describe('expandRange - recurring', () => {
  it('counts weekly BYDAY=MO,WE,FR occurrences over a 30-day window', () => {
    const event = makeEvent({ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' });
    const occ = expandRange(event, at(2026, 1, 5, 0), at(2026, 2, 4, 0));
    // Mon/Wed/Fri from Jan 5 through Feb 2 (Feb 4 09:00 is past the exclusive end).
    expect(occ).toHaveLength(13);
    expect(occ.every((o) => o.isRecurring)).toBe(true);
    expect(occ[0].occurrenceStartMs).toBe(event.startMs); // first occurrence is the series start
  });

  it('expands the weekdays preset (MO..FR) to business days only', () => {
    const event = makeEvent({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' });
    // Two full work weeks: Jan 5-9 and Jan 12-16 = 10 weekdays.
    const occ = expandRange(event, at(2026, 1, 5, 0), at(2026, 1, 19, 0));
    expect(occ).toHaveLength(10);
  });

  it('honours INTERVAL for daily recurrence', () => {
    const event = makeEvent({ rrule: 'FREQ=DAILY;INTERVAL=3' });
    // Jan 5, 8, 11, 14, 17 within [Jan 5, Jan 20).
    const occ = expandRange(event, at(2026, 1, 5, 0), at(2026, 1, 20, 0));
    expect(occ).toHaveLength(5);
  });

  it('honours COUNT (counted from the series start, not the window)', () => {
    const event = makeEvent({ rrule: 'FREQ=DAILY;COUNT=3' });
    const occ = expandRange(event, at(2026, 1, 1, 0), at(2026, 1, 30, 0));
    expect(occ).toHaveLength(3); // Jan 5, 6, 7 only
  });

  it('honours UNTIL (inclusive of the whole final day for date-only values)', () => {
    const event = makeEvent({ rrule: 'FREQ=DAILY;UNTIL=20260108' });
    const occ = expandRange(event, at(2026, 1, 1, 0), at(2026, 1, 30, 0));
    expect(occ).toHaveLength(4); // Jan 5, 6, 7, 8
  });

  it('picks up a recurring overnight occurrence that crosses into the window', () => {
    const event = makeEvent({ startMs: at(2026, 1, 10, 22), endMs: at(2026, 1, 11, 6), rrule: 'FREQ=DAILY' });
    // Only the night of Jan 11->12 crosses into [Jan 12 00:00, Jan 12 12:00).
    const occ = expandRange(event, at(2026, 1, 12, 0), at(2026, 1, 12, 12));
    expect(occ).toHaveLength(1);
    expect(occ[0].occurrenceStartMs).toBe(at(2026, 1, 11, 22));
  });

  it('caps runaway expansion at the 1000-occurrence limit', () => {
    const event = makeEvent({ rrule: 'FREQ=DAILY' });
    const occ = expandRange(event, at(2026, 1, 5, 0), at(2026, 1, 5, 0) + 5000 * DAY);
    expect(occ).toHaveLength(RRULE_EXPANSION_LIMIT);
  });

  it('falls back to a single occurrence for an unparseable RRULE', () => {
    const event = makeEvent({ rrule: 'FREQ=NONSENSE' });
    const occ = expandRange(event, at(2026, 1, 5, 0), at(2026, 1, 6, 0));
    expect(occ).toHaveLength(1);
    expect(occ[0].isRecurring).toBe(false);
  });
});

describe('lastReminderOccurrence', () => {
  it('returns the one-off start once its reminder lead has elapsed', () => {
    const event = makeEvent({ reminderLeadMs: 15 * 60_000 });
    // 20 minutes before start: reminder (15 min lead) not due yet.
    expect(lastReminderOccurrence(event, event.startMs - 20 * 60_000)).toBeNull();
    // 10 minutes before start: within the lead window -> due.
    expect(lastReminderOccurrence(event, event.startMs - 10 * 60_000)).toBe(event.startMs);
  });

  it('returns the most recent due occurrence for a recurring series', () => {
    const event = makeEvent({ rrule: 'FREQ=DAILY', reminderLeadMs: 0 });
    const now = event.startMs + 2 * DAY + HOUR; // just after the third occurrence started
    expect(lastReminderOccurrence(event, now)).toBe(event.startMs + 2 * DAY);
  });
});
