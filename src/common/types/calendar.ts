/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the Calendar feature (Odysseus assimilation "calendar").
 *
 * A first-class calendar surface with dated events, optional recurrence (stored
 * as a standard iCal RRULE string), and optional lead-time reminders. The
 * reminder half reuses Darhai's existing native-notification plumbing (see
 * CalendarReminderScanner -> IpcCalendarEventEmitter -> notificationBridge
 * .showNotification), NOT a new scheduler - the CronService owns time-based
 * agent dispatch and is untouched here. In Odysseus a calendar reminder is
 * literally a note, so reusing the notes reminder pattern is exactly right.
 *
 * These shapes cross the IPC boundary. All timestamps follow Darhai's UTC
 * epoch-ms `*Ms` naming convention (timezone-per-event is deferred - store UTC).
 */

/** A single calendar event (the persisted series row for a recurring event). */
export type CalendarEvent = {
  id: string;
  userId: string;
  /** Optional grouping calendar id; undefined = the user's default calendar. */
  calendarId?: string;
  title: string;
  description?: string;
  location?: string;
  /** Event start, UTC epoch-ms. */
  startMs: number;
  /** Event end, UTC epoch-ms. `endMs >= startMs` is enforced at the boundary. */
  endMs: number;
  allDay: boolean;
  /** Standard iCal RRULE string (e.g. `FREQ=WEEKLY;BYDAY=MO,WE`); undefined = one-off. */
  rrule?: string;
  /** Semantic color token key (e.g. 'red', 'blue'); undefined = default surface. */
  color?: string;
  /** Lead time before the event start to fire a reminder, in ms; undefined = none. */
  reminderLeadMs?: number;
  /** Epoch-ms the reminder last fired; drives dedupe + recurrence rollover. */
  lastRemindedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
};

/** Fields accepted when creating an event. Server fills id / timestamps / defaults. */
export type CreateCalendarEventParams = {
  userId: string;
  calendarId?: string;
  title?: string;
  description?: string;
  location?: string;
  startMs: number;
  endMs: number;
  allDay?: boolean;
  rrule?: string;
  color?: string;
  reminderLeadMs?: number;
};

/** Partial patch for an existing event. Immutable update - server merges + re-stamps. */
export type UpdateCalendarEventParams = {
  calendarId?: string | null;
  title?: string;
  description?: string;
  location?: string;
  startMs?: number;
  endMs?: number;
  allDay?: boolean;
  /** null clears recurrence; a string sets it; undefined leaves it unchanged. */
  rrule?: string | null;
  color?: string;
  /** null clears the reminder; a number sets it; undefined leaves it unchanged. */
  reminderLeadMs?: number | null;
};

/**
 * A single materialized occurrence of an event within a queried range. For a
 * non-recurring event there is exactly one occurrence equal to the event; for a
 * recurring series each occurrence carries its own start/end instant while the
 * `seriesId` still points back at the persisted row for edit/delete targeting.
 */
export type CalendarOccurrence = CalendarEvent & {
  /** The persisted series row id this occurrence belongs to. */
  seriesId: string;
  /** This occurrence's start, UTC epoch-ms. */
  occurrenceStartMs: number;
  /** This occurrence's end, UTC epoch-ms. */
  occurrenceEndMs: number;
  /** True when this occurrence was produced by RRULE expansion. */
  isRecurring: boolean;
};

/** Payload emitted on any event mutation so open surfaces can refresh. */
export type CalendarEventChangedEvent = {
  eventId: string;
  action: 'created' | 'updated' | 'deleted';
};

/** Payload emitted when an event's reminder fires (drives the in-app toast). */
export type CalendarReminderFiredEvent = {
  eventId: string;
  title: string;
  body: string;
  firedAtMs: number;
};
