/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for NoteService (Odysseus assimilation #9). Uses an in-memory repo
 * and a mock emitter so CRUD, checklist toggling, and reorder are exercised in
 * pure isolation - no Electron / DB / i18n / notification dependency. The i18n +
 * ProcessConfig modules pulled in transitively (via NoteReminderScanner) are
 * mocked so importing the service never boots the real i18n runtime.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@process/services/i18n', () => ({ default: { t: (key: string) => key }, i18nReady: Promise.resolve() }));
vi.mock('@process/utils/initStorage', () => ({ ProcessConfig: { get: vi.fn().mockResolvedValue(true) } }));

import { NoteService } from '@process/services/notes/NoteService';
import type { INoteRepository } from '@process/services/notes/INoteRepository';
import type { INoteEventEmitter } from '@process/services/notes/INoteEventEmitter';
import type { Note } from '@/common/types/notes';

class InMemoryNoteRepository implements INoteRepository {
  private notes = new Map<string, Note>();

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

  async listByUser(userId: string, includeArchived: boolean): Promise<Note[]> {
    return [...this.notes.values()]
      .filter((note) => note.userId === userId && (includeArchived || !note.archived))
      .toSorted(
        (a, b) => Number(b.pinned) - Number(a.pinned) || b.sortOrder - a.sortOrder || b.createdAtMs - a.createdAtMs
      );
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

const USER = 'user-1';

describe('NoteService', () => {
  let repo: InMemoryNoteRepository;
  let emitter: INoteEventEmitter;
  let service: NoteService;

  beforeEach(() => {
    repo = new InMemoryNoteRepository();
    emitter = makeEmitter();
    service = new NoteService(repo, emitter);
  });

  it('creates a note, persists it, and emits a created event', async () => {
    const note = await service.create({ userId: USER, title: '  Buy milk  ', content: 'from the shop' });

    expect(note.id).toMatch(/^note_/);
    expect(note.title).toBe('Buy milk'); // trimmed
    expect(note.userId).toBe(USER);
    expect(note.pinned).toBe(false);
    expect(note.archived).toBe(false);
    expect(note.repeat).toBe('none');

    const stored = await service.get(note.id);
    expect(stored?.content).toBe('from the shop');
    expect(emitter.emitNoteChanged).toHaveBeenCalledWith({ noteId: note.id, action: 'created' });
  });

  it('updates fields immutably and emits an updated event', async () => {
    const note = await service.create({ userId: USER, title: 'A' });
    const updated = await service.update(note.id, { title: 'B', color: 'red', label: 'work' });

    expect(updated.title).toBe('B');
    expect(updated.color).toBe('red');
    expect(updated.label).toBe('work');
    expect(updated.updatedAtMs).toBeGreaterThanOrEqual(note.updatedAtMs);
    expect(emitter.emitNoteChanged).toHaveBeenLastCalledWith({ noteId: note.id, action: 'updated' });
  });

  it('clears the reminder when dueDateMs is set to null', async () => {
    const note = await service.create({ userId: USER, title: 'Ping', dueDateMs: 1_000, repeat: 'daily' });
    expect(note.dueDateMs).toBe(1_000);
    const cleared = await service.update(note.id, { dueDateMs: null });
    expect(cleared.dueDateMs).toBeUndefined();
    expect(cleared.lastRemindedAtMs).toBeUndefined();
  });

  it('deletes a note and emits a deleted event', async () => {
    const note = await service.create({ userId: USER, title: 'gone' });
    await service.delete(note.id);
    expect(await service.get(note.id)).toBeNull();
    expect(emitter.emitNoteChanged).toHaveBeenLastCalledWith({ noteId: note.id, action: 'deleted' });
  });

  it('toggles pin and archive flags', async () => {
    const note = await service.create({ userId: USER, title: 'x' });
    const pinned = await service.togglePin(note.id);
    expect(pinned.pinned).toBe(true);
    const archived = await service.toggleArchive(note.id);
    expect(archived.archived).toBe(true);
  });

  it('toggles a single checklist item without touching the others', async () => {
    const note = await service.create({
      userId: USER,
      noteType: 'todo',
      items: [
        { text: 'a', done: false },
        { text: 'b', done: false },
      ],
    });

    const afterFirst = await service.toggleItem(note.id, 0);
    expect(afterFirst.items?.[0]).toEqual({ text: 'a', done: true });
    expect(afterFirst.items?.[1]).toEqual({ text: 'b', done: false });

    const afterAgain = await service.toggleItem(note.id, 0);
    expect(afterAgain.items?.[0].done).toBe(false);
  });

  it('rejects a checklist toggle whose index is out of range', async () => {
    const note = await service.create({ userId: USER, noteType: 'todo', items: [{ text: 'a', done: false }] });
    await expect(service.toggleItem(note.id, 5)).rejects.toThrow(/out of range/);
  });

  it('reorders notes by reassigning sortOrder from a top-to-bottom id list', async () => {
    const a = await service.create({ userId: USER, title: 'a' });
    const b = await service.create({ userId: USER, title: 'b' });
    const c = await service.create({ userId: USER, title: 'c' });

    // Put c first, then a, then b.
    await service.reorder(USER, [c.id, a.id, b.id]);

    const listed = await service.list(USER, false);
    expect(listed.map((note) => note.id)).toEqual([c.id, a.id, b.id]);
  });

  it('skips reorder for ids that do not belong to the user', async () => {
    const mine = await service.create({ userId: USER, title: 'mine' });
    const theirs = await service.create({ userId: 'user-2', title: 'theirs' });
    const before = (await service.get(theirs.id))!.sortOrder;

    await service.reorder(USER, [theirs.id, mine.id]);

    expect((await service.get(theirs.id))!.sortOrder).toBe(before); // untouched
  });

  it('excludes archived notes from the default list but includes them when asked', async () => {
    const a = await service.create({ userId: USER, title: 'a' });
    await service.create({ userId: USER, title: 'b' });
    await service.toggleArchive(a.id);

    const active = await service.list(USER, false);
    expect(active.some((note) => note.id === a.id)).toBe(false);

    const all = await service.list(USER, true);
    expect(all.some((note) => note.id === a.id)).toBe(true);
  });
});
