/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { getDatabase } from '@process/services/database';
import type { CalendarEvent } from '@/common/types/calendar';

/**
 * Database row structure for the `calendar_events` table (migration v52).
 */
type CalendarEventRow = {
  id: string;
  user_id: string;
  calendar_id: string | null;
  title: string | null;
  description: string | null;
  location: string | null;
  start_ms: number;
  end_ms: number;
  all_day: number;
  rrule: string | null;
  color: string | null;
  reminder_lead_ms: number | null;
  last_reminded_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
};

/** Convert a CalendarEvent into its database row. */
function eventToRow(event: CalendarEvent): CalendarEventRow {
  return {
    id: event.id,
    user_id: event.userId,
    calendar_id: event.calendarId ?? null,
    title: event.title,
    description: event.description ?? null,
    location: event.location ?? null,
    start_ms: event.startMs,
    end_ms: event.endMs,
    all_day: event.allDay ? 1 : 0,
    rrule: event.rrule ?? null,
    color: event.color ?? null,
    reminder_lead_ms: event.reminderLeadMs ?? null,
    last_reminded_at_ms: event.lastRemindedAtMs ?? null,
    created_at_ms: event.createdAtMs,
    updated_at_ms: event.updatedAtMs,
  };
}

/** Convert a database row into a CalendarEvent. */
function rowToEvent(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    userId: row.user_id,
    calendarId: row.calendar_id ?? undefined,
    title: row.title ?? '',
    description: row.description ?? undefined,
    location: row.location ?? undefined,
    startMs: row.start_ms,
    endMs: row.end_ms,
    allDay: row.all_day === 1,
    rrule: row.rrule ?? undefined,
    color: row.color ?? undefined,
    reminderLeadMs: row.reminder_lead_ms ?? undefined,
    lastRemindedAtMs: row.last_reminded_at_ms ?? undefined,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/**
 * CalendarStore - persistence layer for calendar events. Thin, synchronous
 * better-sqlite3 access wrapped in async methods (mirrors NoteStore).
 */
class CalendarStore {
  async insert(event: CalendarEvent): Promise<void> {
    const db = await getDatabase();
    const row = eventToRow(event);
    db.getDriver()
      .prepare(
        `
      INSERT INTO calendar_events (
        id, user_id, calendar_id, title, description, location, start_ms, end_ms,
        all_day, rrule, color, reminder_lead_ms, last_reminded_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        row.id,
        row.user_id,
        row.calendar_id,
        row.title,
        row.description,
        row.location,
        row.start_ms,
        row.end_ms,
        row.all_day,
        row.rrule,
        row.color,
        row.reminder_lead_ms,
        row.last_reminded_at_ms,
        row.created_at_ms,
        row.updated_at_ms
      );
  }

  /** Full-row replace. The service always passes a fully-merged event. */
  async replace(event: CalendarEvent): Promise<void> {
    const db = await getDatabase();
    const row = eventToRow(event);
    db.getDriver()
      .prepare(
        `
      UPDATE calendar_events SET
        user_id = ?, calendar_id = ?, title = ?, description = ?, location = ?,
        start_ms = ?, end_ms = ?, all_day = ?, rrule = ?, color = ?,
        reminder_lead_ms = ?, last_reminded_at_ms = ?, updated_at_ms = ?
      WHERE id = ?
    `
      )
      .run(
        row.user_id,
        row.calendar_id,
        row.title,
        row.description,
        row.location,
        row.start_ms,
        row.end_ms,
        row.all_day,
        row.rrule,
        row.color,
        row.reminder_lead_ms,
        row.last_reminded_at_ms,
        row.updated_at_ms,
        row.id
      );
  }

  async delete(eventId: string): Promise<void> {
    const db = await getDatabase();
    db.getDriver().prepare('DELETE FROM calendar_events WHERE id = ?').run(eventId);
  }

  async getById(eventId: string): Promise<CalendarEvent | null> {
    const db = await getDatabase();
    const row = db.getDriver().prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId) as
      | CalendarEventRow
      | undefined;
    return row ? rowToEvent(row) : null;
  }

  /**
   * Candidate series rows for a range query. Non-recurring rows must overlap
   * `[startMs, endMs)`; recurring rows (non-empty rrule) whose base start is
   * before `endMs` are fetched so their occurrences can be expanded in-process.
   * The (user_id, start_ms, end_ms) composite index backs the user + start scan.
   */
  async listInRange(userId: string, startMs: number, endMs: number): Promise<CalendarEvent[]> {
    const db = await getDatabase();
    const rows = db
      .getDriver()
      .prepare(
        `SELECT * FROM calendar_events
         WHERE user_id = ?
           AND (
             ((rrule IS NULL OR rrule = '') AND start_ms < ? AND end_ms > ?)
             OR
             ((rrule IS NOT NULL AND rrule != '') AND start_ms < ?)
           )
         ORDER BY start_ms ASC`
      )
      .all(userId, endMs, startMs, endMs) as CalendarEventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Events with a reminder lead that could be due at `nowMs`. Non-recurring rows
   * are narrowed to those whose reminder instant (start - lead) has passed;
   * recurring-with-reminder rows are all returned (the scanner resolves the next
   * due occurrence). Kept narrow so the sweep touches few rows.
   */
  async listReminderCandidates(nowMs: number): Promise<CalendarEvent[]> {
    const db = await getDatabase();
    const rows = db
      .getDriver()
      .prepare(
        `SELECT * FROM calendar_events
         WHERE reminder_lead_ms IS NOT NULL
           AND (
             ((rrule IS NULL OR rrule = '') AND (start_ms - reminder_lead_ms) <= ?)
             OR
             (rrule IS NOT NULL AND rrule != '')
           )
         ORDER BY start_ms ASC`
      )
      .all(nowMs) as CalendarEventRow[];
    return rows.map(rowToEvent);
  }
}

// Singleton instance
export const calendarStore = new CalendarStore();
