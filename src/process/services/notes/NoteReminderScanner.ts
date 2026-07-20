/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import i18n, { i18nReady } from '@process/services/i18n';
import { ProcessConfig } from '@process/utils/initStorage';
import type { Note, NoteRepeat } from '@/common/types/notes';
import type { INoteRepository } from './INoteRepository';
import type { INoteEventEmitter } from './INoteEventEmitter';

/** How often the scanner sweeps for due reminders. */
const SCAN_INTERVAL_MS = 60_000;
/**
 * Re-ping window. Once a reminder has fired, it will not fire again for the same
 * occurrence until this long has passed (so a still-overdue reminder nudges
 * again roughly every 25 minutes rather than staying silent forever).
 */
const REPING_WINDOW_MS = 25 * 60_000;

/** Advance an epoch-ms timestamp by one repeat period (calendar-aware). */
function addPeriod(ms: number, repeat: NoteRepeat): number {
  const date = new Date(ms);
  switch (repeat) {
    case 'daily':
      date.setDate(date.getDate() + 1);
      break;
    case 'weekly':
      date.setDate(date.getDate() + 7);
      break;
    case 'monthly':
      date.setMonth(date.getMonth() + 1);
      break;
    case 'yearly':
      date.setFullYear(date.getFullYear() + 1);
      break;
    default:
      break;
  }
  return date.getTime();
}

/**
 * Roll a repeating reminder's due date forward to the next occurrence strictly
 * after `nowMs`. A reminder overdue by several periods jumps straight to the
 * next future slot rather than firing once per missed period.
 */
export function advanceDueDate(dueDateMs: number, repeat: NoteRepeat, nowMs: number): number {
  if (repeat === 'none') return dueDateMs;
  let next = addPeriod(dueDateMs, repeat);
  let guard = 0;
  // Guard against a pathological loop (e.g. an unknown repeat that never
  // advances); 4000 daily steps covers a decade.
  while (next <= nowMs && guard < 4000) {
    next = addPeriod(next, repeat);
    guard += 1;
  }
  return next;
}

/** Reminder body: pending checklist items, else content, else the title. */
export function reminderBodyFromNote(note: Note): string {
  if (note.items && note.items.length > 0) {
    const pending = note.items
      .filter((item) => !item.done)
      .map((item) => item.text.trim())
      .filter((text) => text.length > 0);
    if (pending.length > 0) return pending.join(', ');
  }
  const content = note.content?.trim();
  if (content) return content;
  return note.title.trim();
}

/**
 * NoteReminderScanner - periodically fires due-date reminders through Darhai's
 * existing native-notification path (the same `showNotification` the cron
 * service uses) plus an in-app `onReminderFired` event for a toast.
 *
 * This is NOT a scheduler for agent work - CronService owns that. It only turns
 * a note's `dueDateMs` into a one-shot (or repeating) reminder.
 */
export class NoteReminderScanner {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: INoteRepository,
    private readonly emitter: INoteEventEmitter
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

  /** Decide whether a due note should fire now, applying the dedupe window. */
  shouldFire(note: Note, nowMs: number): boolean {
    if (note.archived) return false;
    if (note.dueDateMs === undefined) return false;
    if (note.dueDateMs > nowMs) return false;
    const last = note.lastRemindedAtMs;
    if (last === undefined) return true; // never reminded
    if (last < note.dueDateMs) return true; // a fresh occurrence (post repeat rollover)
    return nowMs - last >= REPING_WINDOW_MS; // still overdue - re-ping after the window
  }

  /**
   * One sweep: fire every note whose reminder is due and not deduped. Exposed
   * (not private) so tests can drive a single deterministic scan.
   */
  async scanOnce(nowMs: number = Date.now()): Promise<void> {
    // Gate on the note-reminder preference. Default ON: only an explicit
    // `false` disables (mirrors the master `system.notificationEnabled`).
    const enabled = await ProcessConfig.get('system.noteReminderEnabled');
    if (enabled === false) return;

    let dueNotes: Note[];
    try {
      dueNotes = await this.repo.listDueReminders(nowMs);
    } catch (error) {
      console.warn('[NoteReminderScanner] Failed to list due reminders:', error);
      return;
    }

    for (const note of dueNotes) {
      if (!this.shouldFire(note, nowMs)) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.fire(note, nowMs);
    }
  }

  /** Fire one reminder: native notification + in-app event, then stamp / roll over. */
  private async fire(note: Note, nowMs: number): Promise<void> {
    await i18nReady;
    const body = reminderBodyFromNote(note);
    const title = note.title.trim() || i18n.t('notes.reminder.notifTitle');

    // Reuse the shared showNotification path (also gated by the master
    // system.notificationEnabled switch inside notificationBridge).
    await this.emitter.showNotification({ title, body }).catch((err) => {
      console.warn('[NoteReminderScanner] Failed to show notification:', err);
    });

    this.emitter.emitReminderFired({ noteId: note.id, title: note.title, body, firedAtMs: nowMs });

    // Stamp the fired time; advance a repeating reminder to its next occurrence.
    // A non-repeating reminder keeps its due date (it "stays fired").
    const next: Note = { ...note, lastRemindedAtMs: nowMs, updatedAtMs: nowMs };
    if (note.repeat !== 'none' && note.dueDateMs !== undefined) {
      next.dueDateMs = advanceDueDate(note.dueDateMs, note.repeat, nowMs);
    }
    try {
      await this.repo.replace(next);
    } catch (error) {
      console.warn('[NoteReminderScanner] Failed to persist reminder state:', error);
    }
  }
}
