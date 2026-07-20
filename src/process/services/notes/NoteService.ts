/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { uuid } from '@/common/utils';
import type { CreateNoteParams, Note, UpdateNoteParams } from '@/common/types/notes';
import type { INoteRepository } from './INoteRepository';
import type { INoteEventEmitter } from './INoteEventEmitter';
import { NoteReminderScanner } from './NoteReminderScanner';

/**
 * NoteService - CRUD + toggles for the Notes surface (Odysseus assimilation #9).
 *
 * Mirrors CronService's constructor-injection shape (repo + emitter). Every
 * mutation persists an immutably-rebuilt Note and emits a `noteChanged` event so
 * any open surface refreshes. Due-date reminders are owned by an internal
 * NoteReminderScanner started in {@link start} - the CronService scheduler is
 * NOT reused or touched.
 */
export class NoteService {
  private readonly scanner: NoteReminderScanner;

  constructor(
    private readonly repo: INoteRepository,
    private readonly emitter: INoteEventEmitter
  ) {
    this.scanner = new NoteReminderScanner(repo, emitter);
  }

  /** Start the reminder scanner (called once during init). */
  start(): void {
    this.scanner.start();
  }

  /** Stop the reminder scanner (called from before-quit cleanup). */
  shutdown(): void {
    this.scanner.stop();
  }

  async create(params: CreateNoteParams): Promise<Note> {
    const now = Date.now();
    const note: Note = {
      id: `note_${uuid()}`,
      userId: params.userId,
      title: params.title?.trim() ?? '',
      content: params.content?.trim() || undefined,
      items: params.items && params.items.length > 0 ? params.items : undefined,
      noteType: params.noteType ?? 'note',
      color: params.color || undefined,
      label: params.label?.trim() || undefined,
      pinned: params.pinned ?? false,
      archived: false,
      dueDateMs: params.dueDateMs,
      repeat: params.repeat ?? 'none',
      lastRemindedAtMs: undefined,
      // Higher sort order = nearer the top; seed with the creation time so a
      // fresh note lands first until the user reorders.
      sortOrder: now,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.repo.insert(note);
    this.emitter.emitNoteChanged({ noteId: note.id, action: 'created' });
    return note;
  }

  async update(noteId: string, updates: UpdateNoteParams): Promise<Note> {
    const existing = await this.repo.getById(noteId);
    if (!existing) {
      throw new Error(`Note not found: ${noteId}`);
    }
    const next = this.applyUpdates(existing, updates);
    await this.repo.replace(next);
    this.emitter.emitNoteChanged({ noteId, action: 'updated' });
    return next;
  }

  async delete(noteId: string): Promise<void> {
    await this.repo.delete(noteId);
    this.emitter.emitNoteChanged({ noteId, action: 'deleted' });
  }

  async get(noteId: string): Promise<Note | null> {
    return this.repo.getById(noteId);
  }

  async list(userId: string, includeArchived: boolean): Promise<Note[]> {
    return this.repo.listByUser(userId, includeArchived);
  }

  async togglePin(noteId: string): Promise<Note> {
    const existing = await this.repo.getById(noteId);
    if (!existing) {
      throw new Error(`Note not found: ${noteId}`);
    }
    const next: Note = { ...existing, pinned: !existing.pinned, updatedAtMs: Date.now() };
    await this.repo.replace(next);
    this.emitter.emitNoteChanged({ noteId, action: 'updated' });
    return next;
  }

  async toggleArchive(noteId: string): Promise<Note> {
    const existing = await this.repo.getById(noteId);
    if (!existing) {
      throw new Error(`Note not found: ${noteId}`);
    }
    const next: Note = { ...existing, archived: !existing.archived, updatedAtMs: Date.now() };
    await this.repo.replace(next);
    this.emitter.emitNoteChanged({ noteId, action: 'updated' });
    return next;
  }

  /** Flip the `done` flag on one checklist item, immutably. */
  async toggleItem(noteId: string, index: number): Promise<Note> {
    const existing = await this.repo.getById(noteId);
    if (!existing) {
      throw new Error(`Note not found: ${noteId}`);
    }
    const items = existing.items ?? [];
    if (index < 0 || index >= items.length) {
      throw new Error(`Checklist item out of range: ${index}`);
    }
    const nextItems = items.map((item, i) => (i === index ? { text: item.text, done: !item.done } : item));
    const next: Note = { ...existing, items: nextItems, updatedAtMs: Date.now() };
    await this.repo.replace(next);
    this.emitter.emitNoteChanged({ noteId, action: 'updated' });
    return next;
  }

  /**
   * Reassign `sortOrder` from a top-to-bottom ordered id list. The first id gets
   * the highest order so `pinned DESC, sort_order DESC` keeps it on top. Ids not
   * belonging to `userId` are skipped.
   */
  async reorder(userId: string, orderedIds: string[]): Promise<void> {
    const total = orderedIds.length;
    for (let index = 0; index < orderedIds.length; index += 1) {
      const noteId = orderedIds[index];
      // eslint-disable-next-line no-await-in-loop
      const existing = await this.repo.getById(noteId);
      if (!existing || existing.userId !== userId) continue;
      const next: Note = { ...existing, sortOrder: total - index, updatedAtMs: Date.now() };
      // eslint-disable-next-line no-await-in-loop
      await this.repo.replace(next);
    }
    // A single change event lets the list re-fetch the freshly ordered rows.
    this.emitter.emitNoteChanged({ noteId: '', action: 'updated' });
  }

  /** Build the next immutable Note from a partial patch. */
  private applyUpdates(existing: Note, updates: UpdateNoteParams): Note {
    const next: Note = { ...existing, updatedAtMs: Date.now() };
    if (updates.title !== undefined) next.title = updates.title.trim();
    if (updates.content !== undefined) next.content = updates.content.trim() || undefined;
    if (updates.items !== undefined) next.items = updates.items.length > 0 ? updates.items : undefined;
    if (updates.noteType !== undefined) next.noteType = updates.noteType;
    if (updates.color !== undefined) next.color = updates.color || undefined;
    if (updates.label !== undefined) next.label = updates.label.trim() || undefined;
    if (updates.pinned !== undefined) next.pinned = updates.pinned;
    if (updates.archived !== undefined) next.archived = updates.archived;
    if (updates.repeat !== undefined) next.repeat = updates.repeat;
    if (updates.dueDateMs !== undefined) {
      // null clears the reminder (and its fired stamp); a number sets a fresh one.
      if (updates.dueDateMs === null) {
        next.dueDateMs = undefined;
        next.lastRemindedAtMs = undefined;
      } else {
        next.dueDateMs = updates.dueDateMs;
        // A newly-set due date has never fired for this occurrence.
        next.lastRemindedAtMs = undefined;
      }
    }
    return next;
  }
}
