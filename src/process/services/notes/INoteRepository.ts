/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Note } from '@/common/types/notes';

export interface INoteRepository {
  insert(note: Note): Promise<void>;
  replace(note: Note): Promise<void>;
  delete(noteId: string): Promise<void>;
  getById(noteId: string): Promise<Note | null>;
  listByUser(userId: string, includeArchived: boolean): Promise<Note[]>;
  listDueReminders(nowMs: number): Promise<Note[]>;
}
