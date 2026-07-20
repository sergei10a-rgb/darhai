/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { uuid } from '@/common/utils';
import { expandRange } from './recurrence';
import { CalendarReminderScanner } from './CalendarReminderScanner';
import type {
  CalendarEvent,
  CalendarOccurrence,
  CreateCalendarEventParams,
  UpdateCalendarEventParams,
} from '@/common/types/calendar';
import type { ICalendarRepository } from './ICalendarRepository';
import type { ICalendarEventEmitter } from './ICalendarEventEmitter';

/**
 * CalendarService - CRUD + range-expanded listing for the Calendar surface
 * (Odysseus assimilation "calendar").
 *
 * Mirrors NoteService's constructor-injection shape (repo + emitter). Every
 * mutation persists an immutably-rebuilt event and emits an `eventChanged` event
 * so any open surface refreshes. Lead-time reminders are owned by an internal
 * CalendarReminderScanner started in {@link start} - the CronService scheduler is
 * NOT reused or touched. `list` expands recurrence into concrete occurrences.
 */
export class CalendarService {
  private readonly scanner: CalendarReminderScanner;

  constructor(
    private readonly repo: ICalendarRepository,
    private readonly emitter: ICalendarEventEmitter
  ) {
    this.scanner = new CalendarReminderScanner(repo, emitter);
  }

  /** Start the reminder scanner (called once during init). */
  start(): void {
    this.scanner.start();
  }

  /** Stop the reminder scanner (called from before-quit cleanup). */
  shutdown(): void {
    this.scanner.stop();
  }

  async create(params: CreateCalendarEventParams): Promise<CalendarEvent> {
    const now = Date.now();
    const startMs = Math.floor(params.startMs);
    // Guarantee a non-negative duration so overlap/expansion math stays sane.
    const endMs = Math.max(startMs, Math.floor(params.endMs));
    const event: CalendarEvent = {
      id: `cal_${uuid()}`,
      userId: params.userId,
      calendarId: params.calendarId || undefined,
      title: params.title?.trim() ?? '',
      description: params.description?.trim() || undefined,
      location: params.location?.trim() || undefined,
      startMs,
      endMs,
      allDay: params.allDay ?? false,
      rrule: params.rrule?.trim() || undefined,
      color: params.color || undefined,
      reminderLeadMs: params.reminderLeadMs,
      lastRemindedAtMs: undefined,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.repo.insert(event);
    this.emitter.emitEventChanged({ eventId: event.id, action: 'created' });
    return event;
  }

  async update(eventId: string, updates: UpdateCalendarEventParams): Promise<CalendarEvent> {
    const existing = await this.repo.getById(eventId);
    if (!existing) {
      throw new Error(`Calendar event not found: ${eventId}`);
    }
    const next = this.applyUpdates(existing, updates);
    await this.repo.replace(next);
    this.emitter.emitEventChanged({ eventId, action: 'updated' });
    return next;
  }

  async delete(eventId: string): Promise<void> {
    await this.repo.delete(eventId);
    this.emitter.emitEventChanged({ eventId, action: 'deleted' });
  }

  async get(eventId: string): Promise<CalendarEvent | null> {
    return this.repo.getById(eventId);
  }

  /**
   * List a user's occurrences overlapping `[startMs, endMs)`: fetch the candidate
   * series rows, expand each through the recurrence engine, and return the flat
   * occurrence list sorted by start.
   */
  async list(userId: string, startMs: number, endMs: number): Promise<CalendarOccurrence[]> {
    const events = await this.repo.listInRange(userId, startMs, endMs);
    const occurrences: CalendarOccurrence[] = [];
    for (const event of events) {
      occurrences.push(...expandRange(event, startMs, endMs));
    }
    occurrences.sort((a, b) => a.occurrenceStartMs - b.occurrenceStartMs);
    return occurrences;
  }

  /** Build the next immutable event from a partial patch. */
  private applyUpdates(existing: CalendarEvent, updates: UpdateCalendarEventParams): CalendarEvent {
    const next: CalendarEvent = { ...existing, updatedAtMs: Date.now() };
    if (updates.title !== undefined) next.title = updates.title.trim();
    if (updates.description !== undefined) next.description = updates.description.trim() || undefined;
    if (updates.location !== undefined) next.location = updates.location.trim() || undefined;
    if (updates.color !== undefined) next.color = updates.color || undefined;
    if (updates.allDay !== undefined) next.allDay = updates.allDay;
    if (updates.calendarId !== undefined) {
      next.calendarId = updates.calendarId === null ? undefined : updates.calendarId || undefined;
    }
    if (updates.startMs !== undefined) next.startMs = Math.floor(updates.startMs);
    if (updates.endMs !== undefined) next.endMs = Math.floor(updates.endMs);
    // Keep a non-negative duration after any timing change.
    if (next.endMs < next.startMs) next.endMs = next.startMs;
    if (updates.rrule !== undefined) {
      next.rrule = updates.rrule === null ? undefined : updates.rrule.trim() || undefined;
    }
    if (updates.reminderLeadMs !== undefined) {
      next.reminderLeadMs = updates.reminderLeadMs === null ? undefined : updates.reminderLeadMs;
    }
    // Any change to the timing / recurrence / lead resets the fired stamp so the
    // (possibly new) next reminder instant can fire for this occurrence.
    if (updates.startMs !== undefined || updates.rrule !== undefined || updates.reminderLeadMs !== undefined) {
      next.lastRemindedAtMs = undefined;
    }
    return next;
  }
}
