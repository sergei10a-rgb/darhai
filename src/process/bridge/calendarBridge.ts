/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the Calendar feature (Odysseus assimilation "calendar").
 *
 * All mutating verbs are remote-denied (see bridgeAllowlist REMOTE_DENIED_KEYS) -
 * a paired-device WebSocket caller must never edit the local user's calendar. The
 * local renderer contract is still untrusted input crossing a process boundary,
 * so every field is validated / clamped here (mirroring noteBridge) before it
 * reaches the service.
 */

import { ipcBridge } from '@/common';
import { calendarService } from '@process/services/calendar/calendarServiceSingleton';
import type {
  CalendarEvent,
  CalendarOccurrence,
  CreateCalendarEventParams,
  UpdateCalendarEventParams,
} from '@/common/types/calendar';

// --- Boundary validation ---------------------------------------------------

/** Cap on the title / calendarId / id strings (chars). */
const MAX_ID_LEN = 512;
/** Cap on the event title (chars). */
const MAX_TITLE_LEN = 512;
/** Cap on the description body (chars). */
const MAX_DESC_LEN = 50_000;
/** Cap on the location string (chars). */
const MAX_LOCATION_LEN = 1_000;
/** Cap on the RRULE string (chars). */
const MAX_RRULE_LEN = 2_000;
/** Cap on the color token (chars). */
const MAX_COLOR_LEN = 64;
/** Cap on the reminder lead time (~90 days in ms). */
const MAX_REMINDER_LEAD_MS = 90 * 24 * 60 * 60 * 1000;

function safeString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Finite epoch-ms, floored, or undefined. */
function safeMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
}

/** Non-negative finite reminder lead in ms, clamped, or undefined. */
function safeLeadMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.floor(value), MAX_REMINDER_LEAD_MS);
}

function toCreateParams(params: unknown): CreateCalendarEventParams | null {
  const raw = (params && typeof params === 'object' ? params : {}) as Partial<CreateCalendarEventParams>;
  const userId = safeString(raw.userId, MAX_ID_LEN);
  if (!userId) return null;
  const startMs = safeMs(raw.startMs);
  const endMsRaw = safeMs(raw.endMs);
  if (startMs === undefined || endMsRaw === undefined) return null;
  // Never accept a negative duration from the boundary.
  const endMs = Math.max(startMs, endMsRaw);

  const out: CreateCalendarEventParams = { userId, startMs, endMs };
  const calendarId = safeString(raw.calendarId, MAX_ID_LEN);
  if (calendarId) out.calendarId = calendarId;
  const title = safeString(raw.title, MAX_TITLE_LEN);
  if (title) out.title = title;
  const description = safeString(raw.description, MAX_DESC_LEN);
  if (description) out.description = description;
  const location = safeString(raw.location, MAX_LOCATION_LEN);
  if (location) out.location = location;
  if (raw.allDay === true) out.allDay = true;
  const rrule = safeString(raw.rrule, MAX_RRULE_LEN);
  if (rrule) out.rrule = rrule;
  const color = safeString(raw.color, MAX_COLOR_LEN);
  if (color) out.color = color;
  const reminderLeadMs = safeLeadMs(raw.reminderLeadMs);
  if (reminderLeadMs !== undefined) out.reminderLeadMs = reminderLeadMs;
  return out;
}

function toUpdateParams(raw: unknown): UpdateCalendarEventParams {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: UpdateCalendarEventParams = {};
  if ('title' in source) out.title = safeString(source.title, MAX_TITLE_LEN);
  if ('description' in source) out.description = safeString(source.description, MAX_DESC_LEN);
  if ('location' in source) out.location = safeString(source.location, MAX_LOCATION_LEN);
  if ('color' in source) out.color = safeString(source.color, MAX_COLOR_LEN);
  if ('allDay' in source) out.allDay = source.allDay === true;
  if ('calendarId' in source) {
    // Explicit null clears the grouping calendar; a string sets it.
    out.calendarId = source.calendarId === null ? null : safeString(source.calendarId, MAX_ID_LEN);
  }
  if ('startMs' in source) {
    const startMs = safeMs(source.startMs);
    if (startMs !== undefined) out.startMs = startMs;
  }
  if ('endMs' in source) {
    const endMs = safeMs(source.endMs);
    if (endMs !== undefined) out.endMs = endMs;
  }
  if ('rrule' in source) {
    // Explicit null clears recurrence; a string sets it; anything else is ignored.
    out.rrule = source.rrule === null ? null : safeString(source.rrule, MAX_RRULE_LEN);
  }
  if ('reminderLeadMs' in source) {
    if (source.reminderLeadMs === null) out.reminderLeadMs = null;
    else {
      const lead = safeLeadMs(source.reminderLeadMs);
      if (lead !== undefined) out.reminderLeadMs = lead;
    }
  }
  return out;
}

/** Initialize the calendar IPC bridge handlers. */
export function initCalendarBridge(): void {
  ipcBridge.calendar.list.provider(async ({ userId, startMs, endMs }): Promise<CalendarOccurrence[]> => {
    const id = safeString(userId, MAX_ID_LEN);
    const start = safeMs(startMs);
    const end = safeMs(endMs);
    if (!id || start === undefined || end === undefined || end <= start) return [];
    return calendarService.list(id, start, end);
  });

  ipcBridge.calendar.get.provider(async ({ eventId }): Promise<CalendarEvent | null> => {
    const id = safeString(eventId, MAX_ID_LEN);
    if (!id) return null;
    return calendarService.get(id);
  });

  ipcBridge.calendar.create.provider(async (params): Promise<CalendarEvent> => {
    const createParams = toCreateParams(params);
    if (!createParams) {
      throw new Error('calendar.create: userId, startMs and endMs are required');
    }
    return calendarService.create(createParams);
  });

  ipcBridge.calendar.update.provider(async ({ eventId, updates }): Promise<CalendarEvent> => {
    const id = safeString(eventId, MAX_ID_LEN);
    if (!id) throw new Error('calendar.update: eventId is required');
    return calendarService.update(id, toUpdateParams(updates));
  });

  ipcBridge.calendar.delete.provider(async ({ eventId }): Promise<void> => {
    const id = safeString(eventId, MAX_ID_LEN);
    if (!id) return;
    await calendarService.delete(id);
  });
}
