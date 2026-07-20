/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for NoteReminderScanner (Odysseus assimilation #9). The reminder
 * fire path reuses Darhai's native-notification plumbing, so the emitter is
 * mocked; i18n + ProcessConfig are mocked so the scan runs with no Electron / DB
 * dependency. Covers: fires when due, dedupe within the re-ping window, repeat
 * rollover advancing dueDateMs, archived notes never firing, and the config gate.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ configGet: vi.fn() }));
vi.mock('@process/services/i18n', () => ({ default: { t: (key: string) => key }, i18nReady: Promise.resolve() }));
vi.mock('@process/utils/initStorage', () => ({ ProcessConfig: { get: mocks.configGet } }));

import { NoteReminderScanner, advanceDueDate, reminderBodyFromNote } from '@process/services/notes/NoteReminderScanner';
import type { INoteRepository } from '@process/services/notes/INoteRepository';
import type { INoteEventEmitter } from '@process/services/notes/INoteEventEmitter';
import type { Note } from '@/common/types/notes';

class InMemoryNoteRepository implements INoteRepository {
  notes = new Map<string, Note>();
  async insert(note: Note): Promise<void> {
    this.notes.set(note.id, { ...note });
  }
  async replace(note: Note): Promise<void> {
    this.notes.set(note.id, { ...note });
  }
  async delete(noteId: string): Promise<void> {
    this.notes.delete(noteId);
  }
  async getById(noteId: string): Promise<Note | null> {
    const note = this.notes.get(noteId);
    return note ? { ...note } : null;
  }
  async listByUser(): Promise<Note[]> {
    return [...this.notes.values()];
  }
  async listDueReminders(nowMs: number): Promise<Note[]> {
    return [...this.notes.values()].filter(
      (note) => !note.archived && note.dueDateMs !== undefined && note.dueDateMs <= nowMs
    );
  }
}

function makeEmitter(): INoteEventEmitter {
  return {
    emitNoteChanged: vi.fn(),
    emitReminderFired: vi.fn(),
    showNotification: vi.fn().mockResolvedValue(undefined),
  };
}

const NOW = 1_700_000_000_000;

function makeNote(overrides: Partial<Note>): Note {
  return {
    id: 'note_1',
    userId: 'user-1',
    title: 'Reminder',
    noteType: 'note',
    pinned: false,
    archived: false,
    repeat: 'none',
    sortOrder: 0,
    createdAtMs: NOW - 100_000,
    updatedAtMs: NOW - 100_000,
    ...overrides,
  };
}

describe('NoteReminderScanner', () => {
  let repo: InMemoryNoteRepository;
  let emitter: INoteEventEmitter;
  let scanner: NoteReminderScanner;

  beforeEach(() => {
    repo = new InMemoryNoteRepository();
    emitter = makeEmitter();
    scanner = new NoteReminderScanner(repo, emitter);
    mocks.configGet.mockReset();
    mocks.configGet.mockResolvedValue(true); // reminders enabled by default
  });

  it('fires a due reminder: native notification + in-app event, then stamps lastRemindedAtMs', async () => {
    await repo.insert(makeNote({ dueDateMs: NOW - 1_000, content: 'water the plants' }));

    await scanner.scanOnce(NOW);

    expect(emitter.showNotification).toHaveBeenCalledTimes(1);
    expect(emitter.showNotification).toHaveBeenCalledWith({ title: 'Reminder', body: 'water the plants' });
    expect(emitter.emitReminderFired).toHaveBeenCalledTimes(1);
    const stored = await repo.getById('note_1');
    expect(stored?.lastRemindedAtMs).toBe(NOW);
  });

  it('does NOT re-fire the same occurrence within the re-ping window (dedupe)', async () => {
    await repo.insert(makeNote({ dueDateMs: NOW - 1_000 }));

    await scanner.scanOnce(NOW);
    expect(emitter.showNotification).toHaveBeenCalledTimes(1);

    // Five minutes later - inside the ~25min re-ping window: must not fire again.
    await scanner.scanOnce(NOW + 5 * 60_000);
    expect(emitter.showNotification).toHaveBeenCalledTimes(1);
  });

  it('re-pings a still-overdue reminder after the re-ping window elapses', async () => {
    await repo.insert(makeNote({ dueDateMs: NOW - 1_000 }));

    await scanner.scanOnce(NOW);
    await scanner.scanOnce(NOW + 26 * 60_000); // past the 25min window

    expect(emitter.showNotification).toHaveBeenCalledTimes(2);
  });

  it('advances dueDateMs to the next occurrence for a repeating reminder', async () => {
    await repo.insert(makeNote({ dueDateMs: NOW - 1_000, repeat: 'daily' }));

    await scanner.scanOnce(NOW);

    const stored = await repo.getById('note_1');
    expect(stored?.dueDateMs).toBeGreaterThan(NOW); // rolled forward to the next future slot
    expect(stored?.lastRemindedAtMs).toBe(NOW);
  });

  it('never fires an archived note even when its due date has passed', async () => {
    await repo.insert(makeNote({ dueDateMs: NOW - 10_000, archived: true }));

    await scanner.scanOnce(NOW);

    expect(emitter.showNotification).not.toHaveBeenCalled();
    expect(emitter.emitReminderFired).not.toHaveBeenCalled();
    expect(scanner.shouldFire(makeNote({ dueDateMs: NOW - 10_000, archived: true }), NOW)).toBe(false);
  });

  it('does nothing when note reminders are disabled in config', async () => {
    mocks.configGet.mockResolvedValue(false);
    await repo.insert(makeNote({ dueDateMs: NOW - 1_000 }));

    await scanner.scanOnce(NOW);

    expect(emitter.showNotification).not.toHaveBeenCalled();
  });

  it('does not fire a note whose due date is still in the future', async () => {
    await repo.insert(makeNote({ dueDateMs: NOW + 60_000 }));
    await scanner.scanOnce(NOW);
    expect(emitter.showNotification).not.toHaveBeenCalled();
  });
});

describe('reminderBodyFromNote', () => {
  it('prefers pending checklist items joined together', () => {
    const note = makeNote({
      noteType: 'todo',
      items: [
        { text: 'milk', done: true },
        { text: 'bread', done: false },
        { text: 'eggs', done: false },
      ],
    });
    expect(reminderBodyFromNote(note)).toBe('bread, eggs');
  });

  it('falls back to content when there are no pending items', () => {
    const note = makeNote({ content: 'call the dentist', items: [{ text: 'x', done: true }] });
    expect(reminderBodyFromNote(note)).toBe('call the dentist');
  });

  it('falls back to the title when there is no content or checklist', () => {
    const note = makeNote({ title: 'Standup' });
    expect(reminderBodyFromNote(note)).toBe('Standup');
  });
});

describe('advanceDueDate', () => {
  it('returns the input unchanged for a non-repeating reminder', () => {
    expect(advanceDueDate(NOW, 'none', NOW + 1)).toBe(NOW);
  });

  it('advances a daily reminder to the next future occurrence', () => {
    const overdueByTwoDays = NOW - 2 * 86_400_000;
    const next = advanceDueDate(overdueByTwoDays, 'daily', NOW);
    expect(next).toBeGreaterThan(NOW);
    // Next slot is within one day past now (it skipped the missed days).
    expect(next - NOW).toBeLessThanOrEqual(86_400_000);
  });
});
