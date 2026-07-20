/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for CalendarService (Odysseus "calendar"). Uses an in-memory repo
 * and a mock emitter so CRUD + range-expanded listing run in pure isolation - no
 * Electron / DB dependency. The i18n + ProcessConfig modules pulled in
 * transitively (via CalendarReminderScanner) are mocked so importing the service
 * never boots the real i18n runtime.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@process/services/i18n', () => ({ default: { t: (key: string) => key }, i18nReady: Promise.resolve() }));
vi.mock('@process/utils/initStorage', () => ({ ProcessConfig: { get: vi.fn().mockResolvedValue(true) } }));

import { CalendarService } from '@process/services/calendar/CalendarService';
import type { ICalendarRepository } from '@process/services/calendar/ICalendarRepository';
import type { ICalendarEventEmitter } from '@process/services/calendar/ICalendarEventEmitter';
import type { CalendarEvent } from '@/common/types/calendar';

const HOUR = 3_600_000;
const DAY = 86_400_000;

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
  async listInRange(userId: string, startMs: number, endMs: number): Promise<CalendarEvent[]> {
    return [...this.events.values()].filter((e) => {
      if (e.userId !== userId) return false;
      const recurring = !!e.rrule && e.rrule.trim() !== '';
      if (recurring) return e.startMs < endMs;
      return e.startMs < endMs && e.endMs > startMs;
    });
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

const USER = 'user-1';
const BASE = new Date(2026, 0, 5, 9, 0, 0).getTime(); // Mon 2026-01-05 09:00 local

describe('CalendarService', () => {
  let repo: InMemoryCalendarRepository;
  let emitter: ICalendarEventEmitter;
  let service: CalendarService;

  beforeEach(() => {
    repo = new InMemoryCalendarRepository();
    emitter = makeEmitter();
    service = new CalendarService(repo, emitter);
  });

  it('creates an event, persists it, and emits a created event', async () => {
    const event = await service.create({
      userId: USER,
      title: '  Team sync  ',
      startMs: BASE,
      endMs: BASE + HOUR,
    });

    expect(event.id).toMatch(/^cal_/);
    expect(event.title).toBe('Team sync'); // trimmed
    expect(event.userId).toBe(USER);
    expect(event.allDay).toBe(false);
    const stored = await service.get(event.id);
    expect(stored?.startMs).toBe(BASE);
    expect(emitter.emitEventChanged).toHaveBeenCalledWith({ eventId: event.id, action: 'created' });
  });

  it('clamps a negative-duration event so endMs is never before startMs', async () => {
    const event = await service.create({ userId: USER, startMs: BASE, endMs: BASE - HOUR });
    expect(event.endMs).toBe(event.startMs);
  });

  it('updates fields immutably and emits an updated event', async () => {
    const event = await service.create({ userId: USER, title: 'A', startMs: BASE, endMs: BASE + HOUR });
    const updated = await service.update(event.id, { title: 'B', color: 'red', location: 'Room 2' });

    expect(updated.title).toBe('B');
    expect(updated.color).toBe('red');
    expect(updated.location).toBe('Room 2');
    expect(emitter.emitEventChanged).toHaveBeenLastCalledWith({ eventId: event.id, action: 'updated' });
  });

  it('clears recurrence when rrule is set to null and resets the fired stamp', async () => {
    const event = await service.create({
      userId: USER,
      startMs: BASE,
      endMs: BASE + HOUR,
      rrule: 'FREQ=DAILY',
      reminderLeadMs: 0,
    });
    // Simulate a prior reminder fire.
    await repo.replace({ ...(await repo.getById(event.id))!, lastRemindedAtMs: BASE });
    const cleared = await service.update(event.id, { rrule: null });
    expect(cleared.rrule).toBeUndefined();
    expect(cleared.lastRemindedAtMs).toBeUndefined();
  });

  it('deletes an event and emits a deleted event', async () => {
    const event = await service.create({ userId: USER, title: 'gone', startMs: BASE, endMs: BASE + HOUR });
    await service.delete(event.id);
    expect(await service.get(event.id)).toBeNull();
    expect(emitter.emitEventChanged).toHaveBeenLastCalledWith({ eventId: event.id, action: 'deleted' });
  });

  it('lists a non-recurring event as a single occurrence within range', async () => {
    await service.create({ userId: USER, title: 'One-off', startMs: BASE, endMs: BASE + HOUR });
    const occ = await service.list(USER, BASE - DAY, BASE + DAY);
    expect(occ).toHaveLength(1);
    expect(occ[0].isRecurring).toBe(false);
    expect(occ[0].occurrenceStartMs).toBe(BASE);
  });

  it('expands a recurring event into multiple sorted occurrences', async () => {
    await service.create({ userId: USER, title: 'Daily', startMs: BASE, endMs: BASE + HOUR, rrule: 'FREQ=DAILY' });
    const occ = await service.list(USER, BASE, BASE + 5 * DAY);
    expect(occ).toHaveLength(5);
    expect(occ.every((o) => o.isRecurring)).toBe(true);
    // Sorted ascending by occurrence start.
    for (let i = 1; i < occ.length; i += 1) {
      expect(occ[i].occurrenceStartMs).toBeGreaterThan(occ[i - 1].occurrenceStartMs);
    }
  });

  it('scopes the list to the requesting user', async () => {
    await service.create({ userId: USER, title: 'mine', startMs: BASE, endMs: BASE + HOUR });
    await service.create({ userId: 'user-2', title: 'theirs', startMs: BASE, endMs: BASE + HOUR });
    const occ = await service.list(USER, BASE - DAY, BASE + DAY);
    expect(occ).toHaveLength(1);
    expect(occ[0].title).toBe('mine');
  });
});
