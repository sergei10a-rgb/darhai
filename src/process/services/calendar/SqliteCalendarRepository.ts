/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { calendarStore } from './CalendarStore';
import type { ICalendarRepository } from './ICalendarRepository';
import type { CalendarEvent } from '@/common/types/calendar';

/** Thin delegation wrapper around the CalendarStore singleton (mirrors SqliteNoteRepository). */
export class SqliteCalendarRepository implements ICalendarRepository {
  async insert(event: CalendarEvent): Promise<void> {
    await calendarStore.insert(event);
  }

  async replace(event: CalendarEvent): Promise<void> {
    await calendarStore.replace(event);
  }

  async delete(eventId: string): Promise<void> {
    await calendarStore.delete(eventId);
  }

  async getById(eventId: string): Promise<CalendarEvent | null> {
    return calendarStore.getById(eventId);
  }

  async listInRange(userId: string, startMs: number, endMs: number): Promise<CalendarEvent[]> {
    return calendarStore.listInRange(userId, startMs, endMs);
  }

  async listReminderCandidates(nowMs: number): Promise<CalendarEvent[]> {
    return calendarStore.listReminderCandidates(nowMs);
  }
}
