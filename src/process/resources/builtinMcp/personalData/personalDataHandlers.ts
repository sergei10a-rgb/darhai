/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read handlers behind the `darhai-personal-data` MCP tools.
 *
 * These run in the Electron main process, NOT in the spawned MCP subprocess.
 * Everything they need already lives here: the one SQLite connection, the local
 * `users` row, the recurrence engine, and the memory index. Each handler
 * therefore delegates to the same service the UI calls - it never reaches into
 * a repository or re-derives a query - so a fix to recurrence expansion or to
 * memory search lands on the model's view of the data at the same instant it
 * lands on the user's.
 *
 * Every handler is a read. See `personalDataTools.ts` for why there is no
 * mutating counterpart.
 */

import { getDatabase } from '@process/services/database/export';
import { calendarService } from '@process/services/calendar/calendarServiceSingleton';
import { noteService } from '@process/services/notes/noteServiceSingleton';
import { documentService } from '@process/services/documents/documentServiceSingleton';
import { getIjfwArchiveService } from '@process/services/memory/ijfwArchiveService';
import { PERSONAL_DATA_TOOL_NAMES, normalizeLimit, type PersonalDataToolName } from './personalDataTools';

/** Characters of document body kept around a search hit in the result list. */
const DOCUMENT_EXCERPT_RADIUS = 240;
/** Window used when the caller supplies a text query but no explicit dates. */
const CALENDAR_QUERY_WINDOW_DAYS = 400;

/**
 * Case- and script-insensitive containment test.
 *
 * NFC-normalises both sides before folding case: Mongolian Cyrillic typed on
 * different keyboards / pasted from different sources can arrive decomposed
 * (e.g. `Ө` as `О` + combining macron), and an un-normalised compare silently
 * misses those rows. `toLowerCase` already folds Cyrillic correctly.
 */
function containsText(haystack: string | undefined | null, needle: string): boolean {
  if (!haystack) return false;
  return haystack.normalize('NFC').toLowerCase().includes(needle);
}

/** Normalise a query once, for repeated use against many candidate fields. */
function normalizeQuery(query: string): string {
  return query.normalize('NFC').toLowerCase();
}

/**
 * Parse `YYYY-MM-DD` as local midnight.
 *
 * `new Date('2026-08-01')` is parsed as UTC by the spec, which shifts the whole
 * day for anyone east or west of Greenwich - "what is on my calendar today"
 * would silently answer for the wrong day in Ulaanbaatar (UTC+8). Constructing
 * the components explicitly keeps the window in the user's own day.
 */
function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Local midnight of the day containing `at`. */
function startOfLocalDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), 0, 0, 0, 0);
}

/** Exclusive end of the local day `days` after the day containing `at`. */
function endOfLocalDay(at: Date, days = 0): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + days + 1, 0, 0, 0, 0);
}

/**
 * Resolve the window a calendar call should scan.
 *
 * - explicit dates win;
 * - a bare text query with no dates scans a wide band around today, because a
 *   "when is my dentist appointment" question cannot name the date it is
 *   looking for;
 * - otherwise: today.
 */
function resolveCalendarWindow(args: {
  startDate?: string;
  endDate?: string;
  query?: string;
}): { startMs: number; endMs: number } {
  const now = new Date();
  const explicitStart = args.startDate ? parseLocalDate(args.startDate) : null;
  const explicitEnd = args.endDate ? parseLocalDate(args.endDate) : null;

  if (explicitStart || explicitEnd) {
    const start = explicitStart ?? startOfLocalDay(explicitEnd as Date);
    const end = explicitEnd ? endOfLocalDay(explicitEnd) : endOfLocalDay(start);
    return { startMs: start.getTime(), endMs: Math.max(start.getTime(), end.getTime()) };
  }

  if (args.query && args.query.trim()) {
    const half = CALENDAR_QUERY_WINDOW_DAYS;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - half, 0, 0, 0, 0);
    return { startMs: start.getTime(), endMs: endOfLocalDay(now, half).getTime() };
  }

  return { startMs: startOfLocalDay(now).getTime(), endMs: endOfLocalDay(now).getTime() };
}

/** ISO-8601 rendering so the model reads an unambiguous instant. */
function iso(ms: number | undefined): string | undefined {
  return typeof ms === 'number' ? new Date(ms).toISOString() : undefined;
}

/**
 * The desktop profile's own `users` row id.
 *
 * Every per-user table keys on it, and this subprocess-facing surface must
 * resolve the SAME identity the renderer gets from `local-user.get` - inventing
 * an id here would read back empty and quietly report "you have no events".
 */
async function resolveUserId(): Promise<string> {
  const db = await getDatabase();
  return db.getOrCreateSystemUser().id;
}

async function handleCalendar(args: {
  query?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): Promise<unknown> {
  const userId = await resolveUserId();
  const { startMs, endMs } = resolveCalendarWindow(args);
  const limit = normalizeLimit(args.limit);

  const occurrences = await calendarService.list(userId, startMs, endMs);
  const query = args.query?.trim();
  const filtered = query
    ? occurrences.filter((o) => {
        const needle = normalizeQuery(query);
        return containsText(o.title, needle) || containsText(o.description, needle) || containsText(o.location, needle);
      })
    : occurrences;

  return {
    window: { from: iso(startMs), to: iso(endMs) },
    total: filtered.length,
    events: filtered.slice(0, limit).map((o) => ({
      id: o.seriesId,
      title: o.title,
      description: o.description,
      location: o.location,
      start: iso(o.occurrenceStartMs),
      end: iso(o.occurrenceEndMs),
      allDay: o.allDay,
      recurring: o.isRecurring,
    })),
  };
}

async function handleNotes(args: { query?: string; includeArchived?: boolean; limit?: number }): Promise<unknown> {
  const userId = await resolveUserId();
  const limit = normalizeLimit(args.limit);

  const notes = await noteService.list(userId, args.includeArchived === true);
  const query = args.query?.trim();
  const filtered = query
    ? notes.filter((n) => {
        const needle = normalizeQuery(query);
        return (
          containsText(n.title, needle) ||
          containsText(n.content, needle) ||
          containsText(n.label, needle) ||
          (n.items ?? []).some((item) => containsText(item.text, needle))
        );
      })
    : notes;

  return {
    total: filtered.length,
    notes: filtered.slice(0, limit).map((n) => ({
      id: n.id,
      title: n.title,
      content: n.content,
      items: n.items,
      noteType: n.noteType,
      label: n.label,
      pinned: n.pinned,
      archived: n.archived,
      dueDate: iso(n.dueDateMs),
      updatedAt: iso(n.updatedAtMs),
    })),
  };
}

/** Slice `content` around the first hit so a long document stays readable. */
function excerpt(content: string, needle: string): string {
  const index = content.normalize('NFC').toLowerCase().indexOf(needle);
  if (index < 0) return content.slice(0, DOCUMENT_EXCERPT_RADIUS);
  const from = Math.max(0, index - DOCUMENT_EXCERPT_RADIUS / 2);
  const to = Math.min(content.length, index + needle.length + DOCUMENT_EXCERPT_RADIUS / 2);
  return `${from > 0 ? '...' : ''}${content.slice(from, to)}${to < content.length ? '...' : ''}`;
}

async function handleDocuments(args: {
  query?: string;
  documentId?: string;
  includeArchived?: boolean;
  limit?: number;
}): Promise<unknown> {
  const userId = await resolveUserId();

  if (args.documentId) {
    const doc = await documentService.get(args.documentId);
    // Ownership check: the tool must never hand back another profile's row even
    // if an id leaks into the conversation.
    if (!doc || doc.userId !== userId) {
      return { document: null, message: `No document found with id '${args.documentId}'.` };
    }
    return {
      document: {
        id: doc.id,
        title: doc.title,
        language: doc.language,
        content: doc.content,
        archived: doc.archived,
        updatedAt: iso(doc.updatedAtMs),
      },
    };
  }

  const limit = normalizeLimit(args.limit);
  const docs = await documentService.list(userId, args.includeArchived === true);
  const query = args.query?.trim();
  const needle = query ? normalizeQuery(query) : '';
  const filtered = query
    ? docs.filter((d) => containsText(d.title, needle) || containsText(d.content, needle))
    : docs;

  return {
    total: filtered.length,
    documents: filtered.slice(0, limit).map((d) => ({
      id: d.id,
      title: d.title,
      language: d.language,
      archived: d.archived,
      updatedAt: iso(d.updatedAtMs),
      excerpt: needle ? excerpt(d.content, needle) : d.content.slice(0, DOCUMENT_EXCERPT_RADIUS),
    })),
  };
}

async function handleMemory(args: { query?: string; limit?: number }): Promise<unknown> {
  const query = args.query?.trim();
  if (!query) {
    return { total: 0, entries: [], message: 'A `query` is required to recall memory.' };
  }
  const limit = normalizeLimit(args.limit);

  // Reuse the archive service's own search lane verbatim. It is the path the
  // Memory surface uses and the one measured to return nothing for gibberish;
  // a second matcher here would drift from it.
  const { entries, total } = await getIjfwArchiveService().listEntries({ search: query, limit });

  return {
    total,
    entries: entries.map((e) => ({
      id: e.id,
      type: e.type,
      project: e.project,
      summary: e.summary,
      body: e.body ?? e.bodyPreview,
      why: e.why,
      howToApply: e.howToApply,
      tags: e.tags,
      storedAt: iso(e.storedAt),
    })),
  };
}

/**
 * Dispatch one personal-data tool call. Returns the JSON payload the bridge
 * serialises back to the model. Throws on an unknown tool so a typo surfaces
 * instead of silently returning an empty result.
 */
export async function callPersonalDataTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName as PersonalDataToolName) {
    case PERSONAL_DATA_TOOL_NAMES.calendar:
      return handleCalendar(args as Parameters<typeof handleCalendar>[0]);
    case PERSONAL_DATA_TOOL_NAMES.notes:
      return handleNotes(args as Parameters<typeof handleNotes>[0]);
    case PERSONAL_DATA_TOOL_NAMES.documents:
      return handleDocuments(args as Parameters<typeof handleDocuments>[0]);
    case PERSONAL_DATA_TOOL_NAMES.memory:
      return handleMemory(args as Parameters<typeof handleMemory>[0]);
    default:
      throw new Error(`Unknown personal-data tool: ${toolName}`);
  }
}
