/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the Notes feature (Odysseus assimilation #9).
 *
 * Notes are a first-class surface for jotting content + checklists with optional
 * due-date reminders. The reminder half reuses Darhai's existing native-
 * notification plumbing (see NoteReminderScanner -> IpcNoteEventEmitter ->
 * notificationBridge.showNotification), NOT a new scheduler - the CronService
 * already owns time-based agent dispatch and is untouched here.
 *
 * These shapes cross the IPC boundary. All timestamps follow Darhai's epoch-ms
 * `*AtMs` naming convention.
 */

/** A plain note vs. a checklist-style todo. */
export type NoteType = 'note' | 'todo';

/** How a due-date reminder repeats after it first fires. */
export type NoteRepeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

/** One line in a note's checklist. */
export type NoteChecklistItem = {
  text: string;
  done: boolean;
};

/** A single note. */
export type Note = {
  id: string;
  userId: string;
  title: string;
  content?: string;
  items?: NoteChecklistItem[];
  noteType: NoteType;
  /** Semantic color token key (e.g. 'red', 'blue'); undefined = default surface. */
  color?: string;
  /** Free-form label / tag for grouping. */
  label?: string;
  pinned: boolean;
  archived: boolean;
  /** Epoch-ms of the next due-date reminder; undefined = no reminder. */
  dueDateMs?: number;
  repeat: NoteRepeat;
  /** Epoch-ms the reminder last fired; drives dedupe + repeat rollover. */
  lastRemindedAtMs?: number;
  sortOrder: number;
  createdAtMs: number;
  updatedAtMs: number;
};

/** Fields accepted when creating a note. Server fills id / timestamps / defaults. */
export type CreateNoteParams = {
  userId: string;
  title?: string;
  content?: string;
  items?: NoteChecklistItem[];
  noteType?: NoteType;
  color?: string;
  label?: string;
  pinned?: boolean;
  dueDateMs?: number;
  repeat?: NoteRepeat;
};

/** Partial patch for an existing note. Immutable update - server merges + re-stamps. */
export type UpdateNoteParams = {
  title?: string;
  content?: string;
  items?: NoteChecklistItem[];
  noteType?: NoteType;
  color?: string;
  label?: string;
  pinned?: boolean;
  archived?: boolean;
  /** null clears the reminder; number sets it; undefined leaves it unchanged. */
  dueDateMs?: number | null;
  repeat?: NoteRepeat;
};

/** Payload emitted when a note's reminder fires (drives the in-app toast). */
export type NoteReminderFiredEvent = {
  noteId: string;
  title: string;
  body: string;
  firedAtMs: number;
};

/** Payload emitted on any note mutation so open surfaces can refresh. */
export type NoteChangedEvent = {
  noteId: string;
  action: 'created' | 'updated' | 'deleted';
};
