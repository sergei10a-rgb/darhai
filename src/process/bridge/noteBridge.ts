/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the Notes feature (Odysseus assimilation #9).
 *
 * All mutating verbs are remote-denied (see bridgeAllowlist REMOTE_DENIED_KEYS) -
 * a paired-device WebSocket caller must never edit the local user's notes. The
 * local renderer contract is still untrusted input crossing a process boundary,
 * so every field is validated / clamped here (mirroring compareBridge) before it
 * reaches the service.
 */

import { ipcBridge } from '@/common';
import { noteService } from '@process/services/notes/noteServiceSingleton';
import type {
  CreateNoteParams,
  Note,
  NoteChecklistItem,
  NoteRepeat,
  NoteType,
  UpdateNoteParams,
} from '@/common/types/notes';

// --- Boundary validation ---------------------------------------------------

/** Cap on any single title / label / item string (chars). */
const MAX_TITLE_LEN = 512;
/** Cap on the note body (chars). */
const MAX_CONTENT_LEN = 50_000;
/** Cap on a single checklist item's text (chars). */
const MAX_ITEM_LEN = 2_000;
/** Cap on the number of checklist items per note. */
const MAX_ITEMS = 200;
/** Cap on ids handed to reorder in one call. */
const MAX_REORDER_IDS = 2_000;

const NOTE_TYPES: ReadonlySet<string> = new Set<NoteType>(['note', 'todo']);
const NOTE_REPEATS: ReadonlySet<string> = new Set<NoteRepeat>(['none', 'daily', 'weekly', 'monthly', 'yearly']);

function safeString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function safeNoteType(value: unknown): NoteType | undefined {
  return typeof value === 'string' && NOTE_TYPES.has(value) ? (value as NoteType) : undefined;
}

function safeRepeat(value: unknown): NoteRepeat | undefined {
  return typeof value === 'string' && NOTE_REPEATS.has(value) ? (value as NoteRepeat) : undefined;
}

/** Positive finite epoch-ms, or undefined. */
function safeDueMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** Validate + clamp a checklist array (drops malformed entries, hard-caps count). */
function safeItems(value: unknown): NoteChecklistItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: NoteChecklistItem[] = [];
  for (const entry of value) {
    if (items.length >= MAX_ITEMS) break;
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Partial<NoteChecklistItem>;
    items.push({ text: safeString(raw.text, MAX_ITEM_LEN), done: raw.done === true });
  }
  return items;
}

function toCreateParams(params: unknown): CreateNoteParams | null {
  const raw = (params && typeof params === 'object' ? params : {}) as Partial<CreateNoteParams>;
  const userId = safeString(raw.userId, MAX_TITLE_LEN);
  if (!userId) return null;
  const out: CreateNoteParams = { userId };
  const title = safeString(raw.title, MAX_TITLE_LEN);
  if (title) out.title = title;
  const content = safeString(raw.content, MAX_CONTENT_LEN);
  if (content) out.content = content;
  const items = safeItems(raw.items);
  if (items) out.items = items;
  const noteType = safeNoteType(raw.noteType);
  if (noteType) out.noteType = noteType;
  const color = safeString(raw.color, MAX_TITLE_LEN);
  if (color) out.color = color;
  const label = safeString(raw.label, MAX_TITLE_LEN);
  if (label) out.label = label;
  if (raw.pinned === true) out.pinned = true;
  const dueDateMs = safeDueMs(raw.dueDateMs);
  if (dueDateMs !== undefined) out.dueDateMs = dueDateMs;
  const repeat = safeRepeat(raw.repeat);
  if (repeat) out.repeat = repeat;
  return out;
}

function toUpdateParams(raw: unknown): UpdateNoteParams {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: UpdateNoteParams = {};
  if ('title' in source) out.title = safeString(source.title, MAX_TITLE_LEN);
  if ('content' in source) out.content = safeString(source.content, MAX_CONTENT_LEN);
  if ('items' in source) out.items = safeItems(source.items) ?? [];
  if ('noteType' in source) {
    const noteType = safeNoteType(source.noteType);
    if (noteType) out.noteType = noteType;
  }
  if ('color' in source) out.color = safeString(source.color, MAX_TITLE_LEN);
  if ('label' in source) out.label = safeString(source.label, MAX_TITLE_LEN);
  if ('pinned' in source) out.pinned = source.pinned === true;
  if ('archived' in source) out.archived = source.archived === true;
  if ('repeat' in source) {
    const repeat = safeRepeat(source.repeat);
    if (repeat) out.repeat = repeat;
  }
  if ('dueDateMs' in source) {
    // Explicit null clears the reminder; a number sets it; anything else is ignored.
    if (source.dueDateMs === null) out.dueDateMs = null;
    else {
      const dueDateMs = safeDueMs(source.dueDateMs);
      if (dueDateMs !== undefined) out.dueDateMs = dueDateMs;
    }
  }
  return out;
}

/** Initialize the note IPC bridge handlers. */
export function initNoteBridge(): void {
  ipcBridge.note.list.provider(async ({ userId, includeArchived }): Promise<Note[]> => {
    const id = safeString(userId, MAX_TITLE_LEN);
    if (!id) return [];
    return noteService.list(id, includeArchived === true);
  });

  ipcBridge.note.get.provider(async ({ noteId }): Promise<Note | null> => {
    const id = safeString(noteId, MAX_TITLE_LEN);
    if (!id) return null;
    return noteService.get(id);
  });

  ipcBridge.note.create.provider(async (params): Promise<Note> => {
    const createParams = toCreateParams(params);
    if (!createParams) {
      throw new Error('note.create: userId is required');
    }
    return noteService.create(createParams);
  });

  ipcBridge.note.update.provider(async ({ noteId, updates }): Promise<Note> => {
    const id = safeString(noteId, MAX_TITLE_LEN);
    if (!id) throw new Error('note.update: noteId is required');
    return noteService.update(id, toUpdateParams(updates));
  });

  ipcBridge.note.delete.provider(async ({ noteId }): Promise<void> => {
    const id = safeString(noteId, MAX_TITLE_LEN);
    if (!id) return;
    await noteService.delete(id);
  });

  ipcBridge.note.togglePin.provider(async ({ noteId }): Promise<Note> => {
    const id = safeString(noteId, MAX_TITLE_LEN);
    if (!id) throw new Error('note.togglePin: noteId is required');
    return noteService.togglePin(id);
  });

  ipcBridge.note.toggleArchive.provider(async ({ noteId }): Promise<Note> => {
    const id = safeString(noteId, MAX_TITLE_LEN);
    if (!id) throw new Error('note.toggleArchive: noteId is required');
    return noteService.toggleArchive(id);
  });

  ipcBridge.note.toggleItem.provider(async ({ noteId, index }): Promise<Note> => {
    const id = safeString(noteId, MAX_TITLE_LEN);
    if (!id) throw new Error('note.toggleItem: noteId is required');
    const safeIndex = typeof index === 'number' && Number.isInteger(index) ? index : -1;
    return noteService.toggleItem(id, safeIndex);
  });

  ipcBridge.note.reorder.provider(async ({ userId, orderedIds }): Promise<void> => {
    const id = safeString(userId, MAX_TITLE_LEN);
    if (!id) return;
    const ids = Array.isArray(orderedIds)
      ? orderedIds.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_REORDER_IDS)
      : [];
    if (ids.length === 0) return;
    await noteService.reorder(id, ids);
  });
}
