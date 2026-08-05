/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Opening a bundled routine for editing used to rewrite its schedule.
 *
 * The list view reads a cron expression through `formatSchedule`, which has
 * always understood both weekday spellings - the named `WED` and the numeric
 * `3`. The edit dialog read the same expression through `parseCronExpr`, which
 * understood only the named form. Every one of the eight bundled routines uses
 * the numeric form, so the dialog fell through to its "daily 09:00" default:
 * the list said "Weekly on Wednesday", the dialog said "Daily 09:00", and
 * saving made the dialog right. The user's schedule was gone with no error and
 * nothing to undo.
 *
 * These two functions now read one shared weekday table, so the two views
 * cannot disagree again. The tests below pin both halves of that: the parse
 * itself, and the round trip through the expression the dialog rebuilds.
 */

import { describe, expect, it } from 'vitest';
import { normalizeWeekdayToken, parseCronExpr } from '@renderer/pages/cron/cronUtils';

/** How CreateTaskDialog rebuilds the expression from the form state. */
function buildWeeklyExpr(time: string, weekday: string): string {
  const [hour, minute] = time.split(':');
  return `${Number(minute)} ${Number(hour)} * * ${weekday}`;
}

describe('normalizeWeekdayToken', () => {
  it('accepts the named form in any case', () => {
    expect(normalizeWeekdayToken('WED')).toBe('WED');
    expect(normalizeWeekdayToken('wed')).toBe('WED');
  });

  it('accepts the numeric form, with 0 and 7 both Sunday', () => {
    expect(normalizeWeekdayToken('0')).toBe('SUN');
    expect(normalizeWeekdayToken('7')).toBe('SUN');
    expect(normalizeWeekdayToken('1')).toBe('MON');
    expect(normalizeWeekdayToken('6')).toBe('SAT');
  });

  it('refuses anything it cannot name as a single day', () => {
    // Ranges and lists are real schedules, but not ones the weekly preset can
    // represent - they belong in the custom expression field, not silently
    // rounded to one day.
    for (const token of ['MON-FRI', '1,3,5', '*', '8', '', '*/2']) {
      expect(normalizeWeekdayToken(token)).toBeNull();
    }
  });
});

describe('parseCronExpr', () => {
  it('reads a numeric weekday as weekly, not as daily 09:00', () => {
    // '0 10 * * 3' is the bundled "weekly digest" routine.
    expect(parseCronExpr('0 10 * * 3')).toEqual({ frequency: 'weekly', time: '10:00', weekday: 'WED' });
  });

  it('reads every numeric weekday a bundled routine uses', () => {
    const cases: Array<[string, string, string]> = [
      ['0 10 * * 3', '10:00', 'WED'],
      ['0 18 * * 0', '18:00', 'SUN'],
      ['0 9 * * 1', '09:00', 'MON'],
      ['0 11 * * 3', '11:00', 'WED'],
      ['0 16 * * 5', '16:00', 'FRI'],
      ['0 11 * * 5', '11:00', 'FRI'],
    ];
    for (const [expr, time, weekday] of cases) {
      expect(parseCronExpr(expr)).toEqual({ frequency: 'weekly', time, weekday });
    }
  });

  it('survives the edit round trip without changing the schedule', () => {
    // Open for edit, change nothing, save. The day and the time must come back
    // out the same - this is the whole defect, stated as one assertion.
    for (const expr of ['0 10 * * 3', '0 18 * * 0', '30 7 * * 6']) {
      const parsed = parseCronExpr(expr);
      const rebuilt = buildWeeklyExpr(parsed.time, parsed.weekday);
      expect(parseCronExpr(rebuilt)).toEqual(parsed);
    }
  });

  it('still reads the named weekday form', () => {
    expect(parseCronExpr('30 14 * * FRI')).toEqual({ frequency: 'weekly', time: '14:30', weekday: 'FRI' });
    expect(parseCronExpr('30 14 * * fri')).toEqual({ frequency: 'weekly', time: '14:30', weekday: 'FRI' });
  });

  it('keeps the other presets it already recognised', () => {
    expect(parseCronExpr('')).toEqual({ frequency: 'manual', time: '09:00', weekday: 'MON' });
    expect(parseCronExpr('0 * * * *')).toEqual({ frequency: 'hourly', time: '09:00', weekday: 'MON' });
    expect(parseCronExpr('15 8 * * MON-FRI')).toEqual({ frequency: 'weekdays', time: '08:15', weekday: 'MON' });
    expect(parseCronExpr('0 7 * * *')).toEqual({ frequency: 'daily', time: '07:00', weekday: 'MON' });
  });

  it('sends a weekday it cannot represent to the custom field, not to daily', () => {
    // Previously '1,3,5' and 'MON-WED' were both flattened to daily 09:00 -
    // the same silent rewrite, one step further out. 'custom' keeps the
    // expression the user wrote.
    expect(parseCronExpr('0 9 * * 1,3,5').frequency).toBe('custom');
    expect(parseCronExpr('0 9 * * MON-WED').frequency).toBe('custom');
  });

  it('treats a malformed expression as custom so it is shown, not replaced', () => {
    expect(parseCronExpr('0 9 *').frequency).toBe('custom');
    expect(parseCronExpr('*/4 * * * *').frequency).toBe('custom');
  });
});
