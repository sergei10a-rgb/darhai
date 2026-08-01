/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool surface of the built-in `darhai-personal-data` MCP server.
 *
 * This module is the ONE declaration of the four tool names, their prose and
 * their argument schemas. It is imported by both sides of the bridge:
 *
 *   - `personalDataMcpStdio.ts` (spawned subprocess) registers them with the
 *     MCP SDK, so this is what the model sees in `tools/list`.
 *   - `personalDataHandlers.ts` (Electron main process) dispatches on the same
 *     names, so a rename cannot desync the advert from the implementation.
 *
 * Keep the imports here to `zod` only. The subprocess bundle must not pull in
 * the database, Electron, or any service through this file.
 *
 * READ-ONLY BY DESIGN
 * -------------------
 * Every tool below is a read. There is deliberately no `create_event` /
 * `write_note` counterpart: a model that can silently mutate the user's
 * calendar produces surprise writes the user never approved and cannot
 * trivially undo, and the capability gap this server closes ("the model cannot
 * see my own data") is entirely a read gap. Writes stay on the UI surfaces and
 * the existing `calendar.create` / `note.create` bridge verbs, where a human
 * initiates them.
 */

import { z } from 'zod';

export const PERSONAL_DATA_TOOL_NAMES = {
  calendar: 'darhai_calendar_search',
  notes: 'darhai_notes_search',
  documents: 'darhai_documents_search',
  memory: 'darhai_memory_recall',
} as const;

export type PersonalDataToolName = (typeof PERSONAL_DATA_TOOL_NAMES)[keyof typeof PERSONAL_DATA_TOOL_NAMES];

/** Upper bound on rows any single tool call may return. */
export const PERSONAL_DATA_MAX_LIMIT = 100;
/** Default row count when the caller does not ask for one. */
export const PERSONAL_DATA_DEFAULT_LIMIT = 25;

const limitSchema = z
  .number()
  .int()
  .positive()
  .max(PERSONAL_DATA_MAX_LIMIT)
  .optional()
  .describe(`Optional. Maximum rows to return (default ${PERSONAL_DATA_DEFAULT_LIMIT}, max ${PERSONAL_DATA_MAX_LIMIT}).`);

const dateSchema = (which: 'first' | 'last') =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional()
    .describe(
      `Optional. ${which === 'first' ? 'First' : 'Last'} day of the window, YYYY-MM-DD in the user's LOCAL time. ` +
        'Omit both dates to search today.'
    );

/** A tool as the stdio bridge needs it: name, prose, and a zod raw shape. */
export type PersonalDataToolSpec = {
  name: PersonalDataToolName;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod raw shapes are heterogeneous by construction
  schema: Record<string, any>;
};

export const PERSONAL_DATA_TOOLS: readonly PersonalDataToolSpec[] = [
  {
    name: PERSONAL_DATA_TOOL_NAMES.calendar,
    description: `Read the user's OWN calendar. Answers "what is on my calendar today / this week", "when is my dentist appointment", "am I free on Friday".

You cannot answer any question about the user's schedule without calling this - their events are NOT in your context.

How it works:
- Returns concrete occurrences (recurring series are already expanded), sorted by start time, each with title, description, location, start/end and an all-day flag.
- \`startDate\`/\`endDate\` bound the window in the user's local time. Omit both to get today.
- \`query\` additionally filters by free text over title, description and location. Matching is case-insensitive and works for Cyrillic as well as Latin text.
- Pass \`query\` with a WIDE date window when you are hunting for an event whose date you do not know.

This tool is read-only; it can never change or delete an event.`,
    schema: {
      query: z
        .string()
        .optional()
        .describe('Optional. Free text to match against event title, description and location.'),
      startDate: dateSchema('first'),
      endDate: dateSchema('last'),
      limit: limitSchema,
    },
  },
  {
    name: PERSONAL_DATA_TOOL_NAMES.notes,
    description: `Read the user's OWN notes and to-do lists. Answers "what did I note about X", "what is on my todo list", "did I write anything about the budget".

You cannot answer any question about the user's notes without calling this - their notes are NOT in your context.

How it works:
- Returns notes newest-pinned-first with title, body, checklist items (and their done state), label, colour and due date.
- \`query\` filters by free text over title, body, checklist item text and label. Case-insensitive; works for Cyrillic as well as Latin text.
- Omit \`query\` to list the most recent notes.
- Archived notes are excluded unless \`includeArchived\` is true.

This tool is read-only; it can never change or delete a note.`,
    schema: {
      query: z.string().optional().describe('Optional. Free text to match against note title, content, items and label.'),
      includeArchived: z.boolean().optional().describe('Optional. Include archived notes (default false).'),
      limit: limitSchema,
    },
  },
  {
    name: PERSONAL_DATA_TOOL_NAMES.documents,
    description: `Search and read the user's OWN documents (the Documents library, not files on disk).

You cannot answer any question about the user's documents without calling this - their content is NOT in your context.

How it works:
- Without \`documentId\`: returns matching documents with title, language and a short excerpt around the match. \`query\` matches title and body text, case-insensitively, for Cyrillic as well as Latin.
- With \`documentId\`: returns that one document's FULL current content. Call the search form first to obtain the id.
- Archived documents are excluded unless \`includeArchived\` is true.

This tool is read-only; it can never change or delete a document.`,
    schema: {
      query: z.string().optional().describe('Optional. Free text to match against document title and body.'),
      documentId: z
        .string()
        .optional()
        .describe('Optional. Return this one document with its full content instead of a search result list.'),
      includeArchived: z.boolean().optional().describe('Optional. Include archived documents (default false).'),
      limit: limitSchema,
    },
  },
  {
    name: PERSONAL_DATA_TOOL_NAMES.memory,
    description: `Recall the user's stored memory - the decisions, preferences, patterns and session notes Darhai has banked over time.

Call this when the user refers to something previously agreed or established ("as we decided", "like last time", "my usual setup"), or when knowing a past decision would change your answer. That history is NOT in your context.

How it works:
- Lexical search over the memory archive; returns entries with type, project, summary, body, tags and when they were stored.
- \`query\` is required and should be the topic in the user's own words. Works for Cyrillic as well as Latin text; a query that matches nothing returns an empty list rather than unrelated entries.

This tool is read-only; it can never write or forget a memory.`,
    schema: {
      query: z.string().min(1).describe('Topic to recall, in the user\'s own words. Be specific.'),
      limit: limitSchema,
    },
  },
] as const;

/** Clamp a caller-supplied limit into the supported range. */
export function normalizeLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return PERSONAL_DATA_DEFAULT_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, PERSONAL_DATA_MAX_LIMIT);
}
