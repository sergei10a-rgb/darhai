/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CalendarEvent } from '@/common/types/calendar';

export interface ICalendarRepository {
  insert(event: CalendarEvent): Promise<void>;
  replace(event: CalendarEvent): Promise<void>;
  delete(eventId: string): Promise<void>;
  getById(eventId: string): Promise<CalendarEvent | null>;
  /**
   * Candidate series rows for a range query: non-recurring rows overlapping
   * `[startMs, endMs)` plus every recurring row whose base start precedes
   * `endMs` (their occurrences are expanded in-process). Mirrors the Odysseus
   * list_events SQL.
   */
  listInRange(userId: string, startMs: number, endMs: number): Promise<CalendarEvent[]>;
  /**
   * Events with a reminder lead set that could be due at `nowMs`: non-recurring
   * rows whose reminder instant has passed, plus every recurring-with-reminder
   * row (their next due occurrence is resolved in the scanner).
   */
  listReminderCandidates(nowMs: number): Promise<CalendarEvent[]>;
}
