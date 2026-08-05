/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rebuild the tail of a conversation as plain text, to hand back to an engine
 * that has just been restarted.
 *
 * Resuming passed the conversation id and nothing else. The engine's `--resume`
 * does not reliably restore history - and when it fails it starts a fresh
 * session rather than saying so - which left the model with no memory of a
 * conversation the chat window was still showing in full. The user asked a
 * follow-up question about something visibly on screen and got an answer from
 * an agent that had never seen it.
 *
 * The transcript is bounded on both axes: the last few turns, then a character
 * cap, so a long conversation cannot push the real question out of the context
 * window in the act of restoring it.
 */

import type { TMessage } from '@/common/chat/chatLib';

/** Turns to replay. Enough for a follow-up to make sense, short enough to stay cheap. */
export const RESUME_HISTORY_MESSAGES = 20;

/** Character cap on the replayed transcript, applied to the tail. */
export const RESUME_HISTORY_CHARS = 4000;

/** One `Speaker: text` line per message, oldest first. */
export function buildResumeHistoryText(
  messages: readonly TMessage[] | undefined,
  limits: { messages?: number; chars?: number } = {}
): string {
  const maxMessages = limits.messages ?? RESUME_HISTORY_MESSAGES;
  const maxChars = limits.chars ?? RESUME_HISTORY_CHARS;

  const lines = (messages ?? [])
    .filter((message): message is Extract<TMessage, { type: 'text' }> => message?.type === 'text')
    // An empty message contributes a bare "User:" line, which reads to the
    // model as a turn that happened and said nothing.
    .filter((message) => Boolean(message.content?.content?.trim()))
    .slice(-maxMessages)
    .map((message) => {
      // `right` is the user's side of the transcript; everything else is the
      // assistant's. Labelling them is what lets the model tell a question it
      // was asked from an answer it gave.
      const speaker = message.position === 'right' ? 'User' : 'Assistant';
      return `${speaker}: ${message.content.content}`;
    });

  // Trim from the front: the most recent turns are the ones a follow-up is
  // about.
  return lines.join('\n').slice(-maxChars);
}
