/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure parsing + prompt-building helpers for the AI edit / suggest loop, ported
 * from Odysseus's `do_edit_document` / `do_suggest_document` (FIND/REPLACE and
 * FIND/SUGGEST/REASON block protocols). Kept side-effect-free so they unit-test
 * without a model, DB, or IPC dependency.
 */

import type { AiSuggestion, DocumentLanguage } from '@/common/types/documents';

/** One targeted find/replace edit parsed from the model's reply. */
export type EditBlock = {
  find: string;
  replace: string;
};

/** Result of applying a batch of edits to a body of text. */
export type ApplyResult = {
  content: string;
  appliedCount: number;
  skippedCount: number;
};

// The FIND/REPLACE and FIND/SUGGEST/REASON blocks the model is asked to emit.
const EDIT_BLOCK_RE = /<<<FIND>>>\n([\s\S]*?)\n<<<REPLACE>>>\n([\s\S]*?)\n<<<END>>>/g;
const SUGGEST_BLOCK_RE = /<<<FIND>>>\n([\s\S]*?)\n<<<SUGGEST>>>\n([\s\S]*?)\n<<<REASON>>>\n([\s\S]*?)\n<<<END>>>/g;

/** Reason phrases that mark a suggestion as a no-op (dropped, mirroring Odysseus). */
const SKIP_PHRASES = ['no change', 'clear', 'fine as', 'looks good', 'no improvement', 'keep as'];

/** Parse every `<<<FIND>>>…<<<REPLACE>>>…<<<END>>>` block from the model reply. */
export function parseEditBlocks(reply: string): EditBlock[] {
  const edits: EditBlock[] = [];
  for (const match of reply.matchAll(EDIT_BLOCK_RE)) {
    edits.push({ find: match[1], replace: match[2] });
  }
  return edits;
}

/**
 * Parse every `<<<FIND>>>…<<<SUGGEST>>>…<<<REASON>>>…<<<END>>>` block, dropping
 * no-op suggestions (find == suggest, or a reason that says nothing needs
 * changing).
 */
export function parseSuggestBlocks(reply: string): AiSuggestion[] {
  const suggestions: AiSuggestion[] = [];
  for (const match of reply.matchAll(SUGGEST_BLOCK_RE)) {
    const find = match[1];
    const suggest = match[2];
    const reason = match[3].trim();
    if (find.trim() === suggest.trim()) continue;
    const lowerReason = reason.toLowerCase();
    if (SKIP_PHRASES.some((phrase) => lowerReason.includes(phrase))) continue;
    suggestions.push({ find, suggest, reason });
  }
  return suggestions;
}

/**
 * Apply the parsed edits to `content`, replacing the first occurrence of each
 * FIND with its REPLACE. When an exact match fails, retry once with a leading
 * `<digits><tab>` line-number gutter stripped from each FIND line (weaker models
 * sometimes copy that reference gutter in) - but only when the stripped form
 * actually matches, so a legitimately tab-prefixed document is never corrupted.
 */
export function applyEdits(content: string, edits: EditBlock[]): ApplyResult {
  let next = content;
  let appliedCount = 0;
  let skippedCount = 0;
  for (const edit of edits) {
    if (next.includes(edit.find)) {
      next = next.replace(edit.find, edit.replace);
      appliedCount += 1;
      continue;
    }
    const stripped = edit.find
      .split('\n')
      .map((line) => line.replace(/^\d+\t/, ''))
      .join('\n');
    if (stripped !== edit.find && next.includes(stripped)) {
      next = next.replace(stripped, edit.replace);
      appliedCount += 1;
      continue;
    }
    skippedCount += 1;
  }
  return { content: next, appliedCount, skippedCount };
}

/**
 * Prompt the model to rewrite the document per `instruction`, replying with ONLY
 * FIND/REPLACE blocks so the edit is applied deterministically main-side.
 */
export function buildEditPrompt(language: DocumentLanguage, content: string, instruction: string): string {
  return [
    `You are editing a ${language} document. Apply the user's instruction with the smallest set of targeted edits.`,
    '',
    'Reply with ONLY edit blocks in this exact format, nothing else:',
    '<<<FIND>>>',
    'exact text to find (copied verbatim from the document)',
    '<<<REPLACE>>>',
    'the replacement text',
    '<<<END>>>',
    '',
    'Each FIND must be copied verbatim from the document below so it matches exactly.',
    'Use as many blocks as needed. Do not add commentary before or after the blocks.',
    '',
    `INSTRUCTION: ${instruction}`,
    '',
    'DOCUMENT:',
    content,
  ].join('\n');
}

/**
 * Prompt the model to propose non-destructive suggestions per `instruction`,
 * replying with ONLY FIND/SUGGEST/REASON blocks. Nothing is written; the user
 * accepts or rejects each in the UI.
 */
export function buildSuggestPrompt(language: DocumentLanguage, content: string, instruction: string): string {
  return [
    `You are reviewing a ${language} document and proposing improvements. Do NOT rewrite it - only suggest changes.`,
    '',
    'Reply with ONLY suggestion blocks in this exact format, nothing else:',
    '<<<FIND>>>',
    'exact text to find (copied verbatim from the document)',
    '<<<SUGGEST>>>',
    'the improved replacement text',
    '<<<REASON>>>',
    'a short reason for the change',
    '<<<END>>>',
    '',
    'Each FIND must be copied verbatim from the document below so it matches exactly.',
    'Skip anything that is already fine. Do not add commentary before or after the blocks.',
    '',
    `INSTRUCTION: ${instruction}`,
    '',
    'DOCUMENT:',
    content,
  ].join('\n');
}
