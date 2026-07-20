/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for CalendarReminderScanner (Odysseus "calendar"). The reminder
 * fire path reuses Darhai's native-notification plumbing, so the emitter is
 * mocked; i18n + ProcessConfig are mocked so the scan runs with no Electron / DB
 * dependency. Covers: fires when due, dedupe within the re-ping window, re-ping
 * after the window, a recurring series advancing to the next occurrence, and the
 * config gate.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ configGet: vi.fn() }));
vi.mock('@process/services/i18n', () => ({ default: { t: (key: string) => key }, i18nReady: Promise.resolve() }));
vi.mock('@process/utils/initStorage', () => ({ ProcessConfig: { get: mocks.configGet } }));

import { CalendarReminderScanner, reminderBodyFromEvent } from '@process/services/calendar/CalendarReminderScanner';
import type { ICalendarRepository } from '@process/services/calendar/ICalendarRepository';
import type { ICalendarEventEmitter } from '@process/services/calendar/ICalendarEventEmitter';
import type { CalendarEvent } from '@/common/types/calendar';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = new Date(2026, 0, 5, 9, 0, 0).getTime();

class InMemoryCalendarRepository implements ICalendarRepository {
  events = new Map<string, CalendarEvent>();
  async insert(event: CalendarEvent): Promise<void> {
    this.events.set(event.id, { ...event });
  }
  async replace(event: CalendarEvent): Promise<void> {
    this.events.set(event.id, { ...event });
  }
  async delete(eventId: string): Promise<void> {
    this.events.delete(eventId);
  }
  async getById(eventId: string): Promise<CalendarEvent | null> {
    const e = this.events.get(eventId);
    return e ? { ...e } : null;
  }
  async listInRange(): Promise<CalendarEvent[]> {
    return [...this.events.values()];
  }
  async listReminderCandidates(nowMs: number): Promise<CalendarEvent[]> {
    return [...this.events.values()].filter((e) => {
      if (e.reminderLeadMs === undefined) return false;
      const recurring = !!e.rrule && e.rrule.trim() !== '';
      if (recurring) return true;
      return e.startMs - e.reminderLeadMs <= nowMs;
    });
  }
}

function makeEmitter(): ICalendarEventEmitter {
  return {
    emitEventChanged: vi.fn(),
    emitReminderFired: vi.fn(),
    showNotification: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEvent(overrides: Partial<CalendarEvent>): CalendarEvent {
  const startMs = overrides.startMs ?? NOW;
  return {
    id: 'cal_1',
    userId: 'user-1',
    title: 'Meeting',
    startMs,
    endMs: startMs + HOUR,
    allDay: false,
    reminderLeadMs: 0,
    createdAtMs: startMs,
    updatedAtMs: startMs,
    ...overrides,
  };
}

describe('CalendarReminderScanner', () => {
  let repo: InMemoryCalendarRepository;
  let emitter: ICalendarEventEmitter;
  let scanner: CalendarReminderScanner;

  beforeEach(() => {
    repo = new InMemoryCalendarRepository();
    emitter = makeEmitter();
    scanner = new CalendarReminderScanner(repo, emitter);
    mocks.configGet.mockReset();
    mocks.configGet.mockResolvedValue(true); // reminders enabled by default
  });

  it('fires a due reminder: native notification + in-app event, then stamps lastRemindedAtMs', async () => {
    await repo.insert(makeEvent({ startMs: NOW - 1_000, description: 'Sync agenda' }));

    await scanner.scanOnce(NOW);

    expect(emitter.showNotification).toHaveBeenCalledTimes(1);
    expect(emitter.showNotification).toHaveBeenCalledWith({ title: 'Meeting', body: 'Sync agenda' });
    expect(emitter.emitReminderFired).toHaveBeenCalledTimes(1);
    const stored = await repo.getById('cal_1');
    expect(stored?.lastRemindedAtMs).toBe(NOW);
  });

  it('respects the reminder lead: does not fire before start - lead', async () => {
    await repo.insert(makeEvent({ startMs: NOW + 20 * 60_000, reminderLeadMs: 15 * 60_000 }));
    await scanner.scanOnce(NOW); // 20 min out, 15 min lead -> not yet due
    expect(emitter.showNotification).not.toHaveBeenCalled();
  });

  it('does NOT re-fire the same occurrence within the re-ping window (dedupe)', async () => {
    await repo.insert(makeEvent({ startMs: NOW - 1_000 }));

    await scanner.scanOnce(NOW);
    expect(emitter.showNotification).toHaveBeenCalledTimes(1);

    await scanner.scanOnce(NOW + 5 * 60_000); // inside the ~25min window
    expect(emitter.showNotification).toHaveBeenCalledTimes(1);
  });

  it('re-pings a still-due reminder after the re-ping window elapses', async () => {
    await repo.insert(makeEvent({ startMs: NOW - 1_000 }));

    await scanner.scanOnce(NOW);
    await scanner.scanOnce(NOW + 26 * 60_000); // past the 25min window

    expect(emitter.showNotification).toHaveBeenCalledTimes(2);
  });

  it('advances a recurring series to the next occurrence', async () => {
    // Daily, first occurrence exactly at NOW, zero lead.
    await repo.insert(makeEvent({ startMs: NOW, rrule: 'FREQ=DAILY' }));

    await scanner.scanOnce(NOW); // fires occurrence 1
    expect(emitter.showNotification).toHaveBeenCalledTimes(1);

    await scanner.scanOnce(NOW + 5 * 60_000); // still occurrence 1, deduped
    expect(emitter.showNotification).toHaveBeenCalledTimes(1);

    await scanner.scanOnce(NOW + DAY); // occurrence 2 is now due -> fires
    expect(emitter.showNotification).toHaveBeenCalledTimes(2);
  });

  it('does nothing when calendar reminders are disabled in config', async () => {
    mocks.configGet.mockResolvedValue(false);
    await repo.insert(makeEvent({ startMs: NOW - 1_000 }));

    await scanner.scanOnce(NOW);

    expect(emitter.showNotification).not.toHaveBeenCalled();
  });

  it('does not fire an event whose reminder instant is still in the future', async () => {
    await repo.insert(makeEvent({ startMs: NOW + 60_000, reminderLeadMs: 0 }));
    await scanner.scanOnce(NOW);
    expect(emitter.showNotification).not.toHaveBeenCalled();
  });
});

describe('reminderBodyFromEvent', () => {
  it('prefers the description', () => {
    expect(reminderBodyFromEvent(makeEvent({ description: 'Bring slides', location: 'Room 1' }))).toBe('Bring slides');
  });

  it('falls back to the location when there is no description', () => {
    expect(reminderBodyFromEvent(makeEvent({ location: 'Room 1' }))).toBe('Room 1');
  });

  it('falls back to the title when there is no description or location', () => {
    expect(reminderBodyFromEvent(makeEvent({ title: 'Standup' }))).toBe('Standup');
  });
});
