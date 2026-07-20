/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { noteStore } from './NoteStore';
import type { INoteRepository } from './INoteRepository';
import type { Note } from '@/common/types/notes';

/** Thin delegation wrapper around the NoteStore singleton (mirrors SqliteCronRepository). */
export class SqliteNoteRepository implements INoteRepository {
  async insert(note: Note): Promise<void> {
    await noteStore.insert(note);
  }

  async replace(note: Note): Promise<void> {
    await noteStore.replace(note);
  }

  async delete(noteId: string): Promise<void> {
    await noteStore.delete(noteId);
  }

  async getById(noteId: string): Promise<Note | null> {
    return noteStore.getById(noteId);
  }

  async listByUser(userId: string, includeArchived: boolean): Promise<Note[]> {
    return noteStore.listByUser(userId, includeArchived);
  }

  async listDueReminders(nowMs: number): Promise<Note[]> {
    return noteStore.listDueReminders(nowMs);
  }
}
