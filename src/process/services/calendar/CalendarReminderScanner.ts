/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import i18n, { i18nReady } from '@process/services/i18n';
import { ProcessConfig } from '@process/utils/initStorage';
import { lastReminderOccurrence } from './recurrence';
import type { CalendarEvent } from '@/common/types/calendar';
import type { ICalendarRepository } from './ICalendarRepository';
import type { ICalendarEventEmitter } from './ICalendarEventEmitter';

/** How often the scanner sweeps for due reminders. */
const SCAN_INTERVAL_MS = 60_000;
/**
 * Re-ping window. Once a reminder has fired, it will not fire again for the same
 * occurrence until this long has passed (so a still-imminent reminder nudges
 * again roughly every 25 minutes rather than staying silent forever).
 */
const REPING_WINDOW_MS = 25 * 60_000;

/** Reminder body: description, else location, else the event title. */
export function reminderBodyFromEvent(event: CalendarEvent): string {
  const description = event.description?.trim();
  if (description) return description;
  const location = event.location?.trim();
  if (location) return location;
  return event.title.trim();
}

/**
 * CalendarReminderScanner - periodically fires lead-time event reminders through
 * Darhai's existing native-notification path (the same `showNotification` the
 * note reminder uses) plus an in-app `onReminderFired` event for a toast.
 *
 * This is NOT a scheduler for agent work - CronService owns that. It only turns
 * an event's `reminderLeadMs` into a one-shot (or per-occurrence) reminder. A
 * recurring event advances naturally: firing stamps `lastRemindedAtMs`, and the
 * next occurrence's reminder instant fires once it passes that stamp.
 */
export class CalendarReminderScanner {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: ICalendarRepository,
    private readonly emitter: ICalendarEventEmitter
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, SCAN_INTERVAL_MS);
    // Never hold the process open just for the reminder sweep.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Decide whether a due reminder instant should fire now, applying the dedupe window. */
  shouldFire(event: CalendarEvent, reminderInstantMs: number, nowMs: number): boolean {
    if (reminderInstantMs > nowMs) return false;
    const last = event.lastRemindedAtMs;
    if (last === undefined) return true; // never reminded
    if (last < reminderInstantMs) return true; // a fresh occurrence (post recurrence rollover)
    return nowMs - last >= REPING_WINDOW_MS; // still imminent - re-ping after the window
  }

  /**
   * One sweep: fire every event whose reminder instant is due and not deduped.
   * Exposed (not private) so tests can drive a single deterministic scan.
   */
  async scanOnce(nowMs: number = Date.now()): Promise<void> {
    // Gate on the calendar-reminder preference. Default ON: only an explicit
    // `false` disables (mirrors the master `system.notificationEnabled`).
    const enabled = await ProcessConfig.get('system.calendarReminderEnabled');
    if (enabled === false) return;

    let candidates: CalendarEvent[];
    try {
      candidates = await this.repo.listReminderCandidates(nowMs);
    } catch (error) {
      console.warn('[CalendarReminderScanner] Failed to list reminder candidates:', error);
      return;
    }

    for (const event of candidates) {
      const occStartMs = lastReminderOccurrence(event, nowMs);
      if (occStartMs === null) continue;
      const reminderInstantMs = occStartMs - (event.reminderLeadMs ?? 0);
      if (!this.shouldFire(event, reminderInstantMs, nowMs)) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.fire(event, nowMs);
    }
  }

  /** Fire one reminder: native notification + in-app event, then stamp lastRemindedAtMs. */
  private async fire(event: CalendarEvent, nowMs: number): Promise<void> {
    await i18nReady;
    const body = reminderBodyFromEvent(event);
    const title = event.title.trim() || i18n.t('calendar.reminder.notifTitle');

    // Reuse the shared showNotification path (also gated by the master
    // system.notificationEnabled switch inside notificationBridge).
    await this.emitter.showNotification({ title, body }).catch((err) => {
      console.warn('[CalendarReminderScanner] Failed to show notification:', err);
    });

    this.emitter.emitReminderFired({ eventId: event.id, title: event.title, body, firedAtMs: nowMs });

    // Stamp the fired time. The occurrence itself is never mutated - recurrence
    // advances naturally because the next occurrence's reminder instant is later
    // than this stamp (see shouldFire).
    const next: CalendarEvent = { ...event, lastRemindedAtMs: nowMs, updatedAtMs: nowMs };
    try {
      await this.repo.replace(next);
    } catch (error) {
      console.warn('[CalendarReminderScanner] Failed to persist reminder state:', error);
    }
  }
}
