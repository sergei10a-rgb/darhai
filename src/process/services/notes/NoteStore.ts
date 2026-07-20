/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { getDatabase } from '@process/services/database';
import type { Note, NoteChecklistItem, NoteRepeat, NoteType } from '@/common/types/notes';

/**
 * Database row structure for the `notes` table (migration v51).
 */
type NoteRow = {
  id: string;
  user_id: string;
  title: string | null;
  content: string | null;
  items: string | null;
  note_type: string;
  color: string | null;
  label: string | null;
  pinned: number;
  archived: number;
  due_date_ms: number | null;
  repeat: string;
  last_reminded_at_ms: number | null;
  sort_order: number;
  created_at_ms: number;
  updated_at_ms: number;
};

/** Parse the JSON `items` column into a checklist array, tolerating malformed data. */
function parseItems(raw: string | null): NoteChecklistItem[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const items = parsed
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => ({
        text: typeof entry.text === 'string' ? entry.text : '',
        done: entry.done === true,
      }));
    return items.length > 0 ? items : undefined;
  } catch {
    return undefined;
  }
}

/** Convert a Note into its database row. */
function noteToRow(note: Note): NoteRow {
  return {
    id: note.id,
    user_id: note.userId,
    title: note.title,
    content: note.content ?? null,
    items: note.items && note.items.length > 0 ? JSON.stringify(note.items) : null,
    note_type: note.noteType,
    color: note.color ?? null,
    label: note.label ?? null,
    pinned: note.pinned ? 1 : 0,
    archived: note.archived ? 1 : 0,
    due_date_ms: note.dueDateMs ?? null,
    repeat: note.repeat,
    last_reminded_at_ms: note.lastRemindedAtMs ?? null,
    sort_order: note.sortOrder,
    created_at_ms: note.createdAtMs,
    updated_at_ms: note.updatedAtMs,
  };
}

/** Convert a database row into a Note. */
function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title ?? '',
    content: row.content ?? undefined,
    items: parseItems(row.items),
    noteType: (row.note_type as NoteType) ?? 'note',
    color: row.color ?? undefined,
    label: row.label ?? undefined,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    dueDateMs: row.due_date_ms ?? undefined,
    repeat: (row.repeat as NoteRepeat) ?? 'none',
    lastRemindedAtMs: row.last_reminded_at_ms ?? undefined,
    sortOrder: row.sort_order,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/**
 * NoteStore - persistence layer for notes. Thin, synchronous better-sqlite3
 * access wrapped in async methods (mirrors CronStore).
 */
class NoteStore {
  async insert(note: Note): Promise<void> {
    const db = await getDatabase();
    const row = noteToRow(note);
    db.getDriver()
      .prepare(
        `
      INSERT INTO notes (
        id, user_id, title, content, items, note_type, color, label,
        pinned, archived, due_date_ms, repeat, last_reminded_at_ms,
        sort_order, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        row.id,
        row.user_id,
        row.title,
        row.content,
        row.items,
        row.note_type,
        row.color,
        row.label,
        row.pinned,
        row.archived,
        row.due_date_ms,
        row.repeat,
        row.last_reminded_at_ms,
        row.sort_order,
        row.created_at_ms,
        row.updated_at_ms
      );
  }

  /** Full-row replace. The service always passes a fully-merged Note. */
  async replace(note: Note): Promise<void> {
    const db = await getDatabase();
    const row = noteToRow(note);
    db.getDriver()
      .prepare(
        `
      UPDATE notes SET
        user_id = ?, title = ?, content = ?, items = ?, note_type = ?,
        color = ?, label = ?, pinned = ?, archived = ?, due_date_ms = ?,
        repeat = ?, last_reminded_at_ms = ?, sort_order = ?, updated_at_ms = ?
      WHERE id = ?
    `
      )
      .run(
        row.user_id,
        row.title,
        row.content,
        row.items,
        row.note_type,
        row.color,
        row.label,
        row.pinned,
        row.archived,
        row.due_date_ms,
        row.repeat,
        row.last_reminded_at_ms,
        row.sort_order,
        row.updated_at_ms,
        row.id
      );
  }

  async delete(noteId: string): Promise<void> {
    const db = await getDatabase();
    db.getDriver().prepare('DELETE FROM notes WHERE id = ?').run(noteId);
  }

  async getById(noteId: string): Promise<Note | null> {
    const db = await getDatabase();
    const row = db.getDriver().prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
    return row ? rowToNote(row) : null;
  }

  /**
   * List a user's notes ordered pinned-first, then by descending sort order,
   * then newest-created. `includeArchived` defaults to false.
   */
  async listByUser(userId: string, includeArchived: boolean): Promise<Note[]> {
    const db = await getDatabase();
    const sql = includeArchived
      ? 'SELECT * FROM notes WHERE user_id = ? ORDER BY pinned DESC, sort_order DESC, created_at_ms DESC'
      : 'SELECT * FROM notes WHERE user_id = ? AND archived = 0 ORDER BY pinned DESC, sort_order DESC, created_at_ms DESC';
    const rows = db.getDriver().prepare(sql).all(userId) as NoteRow[];
    return rows.map(rowToNote);
  }

  /**
   * List all non-archived notes with a due-date reminder at or before `nowMs`.
   * Used by the reminder scanner - kept narrow so the scan touches few rows.
   */
  async listDueReminders(nowMs: number): Promise<Note[]> {
    const db = await getDatabase();
    const rows = db
      .getDriver()
      .prepare(
        'SELECT * FROM notes WHERE archived = 0 AND due_date_ms IS NOT NULL AND due_date_ms <= ? ORDER BY due_date_ms ASC'
      )
      .all(nowMs) as NoteRow[];
    return rows.map(rowToNote);
  }
}

// Singleton instance
export const noteStore = new NoteStore();
