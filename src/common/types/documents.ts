/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the Documents feature (Odysseus assimilation "documents").
 *
 * Darhai already owns the editing SURFACE - the multi-tab Preview panel with
 * markdown / HTML / Monaco editors. The gap this feature fills is a PERSISTENT
 * document entity (DB CRUD + a dedicated library), version history with a save
 * coalescing window, and an AI edit / suggest loop (accept / reject). The page
 * REUSES the existing Preview editors; nothing here forks them.
 *
 * These shapes cross the IPC boundary. All timestamps follow Darhai's UTC
 * epoch-ms `*Ms` naming convention.
 */

/**
 * How a document's body is interpreted, which in turn selects the reused Preview
 * editor: `markdown` -> TipTapMarkdownEditor, `html` -> HTMLEditor, `csv` / `code`
 * -> the CodeMirror TextEditor (CSV is edited as plain text in the MVP).
 */
export type DocumentLanguage = 'markdown' | 'html' | 'csv' | 'code';

/** Where a persisted version came from - a human save or an AI edit. */
export type DocumentVersionSource = 'user' | 'ai';

/** A persisted living document (the current head content + metadata). */
export type DocumentEntity = {
  id: string;
  userId: string;
  title: string;
  language: DocumentLanguage;
  /** The current head content of the document. */
  content: string;
  /** Number of persisted versions; also the next version's number is this + 1. */
  versionCount: number;
  archived: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

/** A single point-in-time snapshot of a document's content. */
export type DocumentVersion = {
  id: string;
  documentId: string;
  versionNumber: number;
  content: string;
  /** Short human-readable summary of what this version captured. */
  summary?: string;
  source: DocumentVersionSource;
  createdAtMs: number;
};

/** Fields accepted when creating a document. Server fills id / timestamps / defaults. */
export type CreateDocumentParams = {
  userId: string;
  title?: string;
  language?: DocumentLanguage;
  content?: string;
};

/**
 * Partial patch for an existing document. Immutable update - the server merges +
 * re-stamps. A content change drives the 60s version-coalescing window; a
 * metadata-only change (title / language / archived) never mints a version.
 */
export type UpdateDocumentParams = {
  title?: string;
  language?: DocumentLanguage;
  content?: string;
  archived?: boolean;
};

/** Payload emitted on any document mutation so open surfaces can refresh. */
export type DocumentChangedEvent = {
  documentId: string;
  action: 'created' | 'updated' | 'deleted';
};

/** Request to have the model rewrite a document from a natural-language instruction. */
export type AiEditRequest = {
  documentId: string;
  instruction: string;
};

/**
 * Result of an AI edit. `applied` is false when the model returned no usable
 * FIND/REPLACE block or none of them matched the current content (the document
 * is left untouched); when true, `newVersion` is the freshly persisted ai version.
 */
export type AiEditResult = {
  applied: boolean;
  newVersion?: DocumentVersion;
};

/**
 * A single non-destructive AI suggestion. The UI renders these as accept / reject
 * cards; nothing is written until the user accepts one.
 */
export type AiSuggestion = {
  find: string;
  suggest: string;
  reason: string;
};
