/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resuming a chat used to hand the engine the conversation id and nothing else.
 *
 * `--resume` does not reliably restore history, and when it fails it starts a
 * fresh session instead of saying so - so the model had no memory of a
 * conversation the chat window was still showing in full. The user asked a
 * follow-up about something visibly on screen and got an answer from an agent
 * that had never seen it.
 *
 * These tests pin the transcript that gets replayed: who said what, in order,
 * bounded so restoring context cannot itself blow the context window.
 */

import { describe, expect, it } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import { RESUME_HISTORY_MESSAGES, buildResumeHistoryText } from '@process/task/resumeHistory';

const text = (content: string, position: 'left' | 'right'): TMessage =>
  ({ type: 'text', position, content: { content } }) as unknown as TMessage;

const user = (content: string) => text(content, 'right');
const assistant = (content: string) => text(content, 'left');

describe('buildResumeHistoryText', () => {
  it('replays the turns in order, labelled by speaker', () => {
    const out = buildResumeHistoryText([
      user('what is in this repo?'),
      assistant('a desktop app'),
      user('and the tests?'),
    ]);

    expect(out).toBe('User: what is in this repo?\nAssistant: a desktop app\nUser: and the tests?');
  });

  it('returns nothing for a conversation with no text yet', () => {
    // A brand-new session has nothing to replay, and injecting an empty
    // transcript would just be noise in the prompt.
    expect(buildResumeHistoryText([])).toBe('');
    expect(buildResumeHistoryText(undefined)).toBe('');
  });

  it('skips messages that are not text', () => {
    const toolCall = { type: 'tool_group', position: 'left', content: {} } as unknown as TMessage;

    expect(buildResumeHistoryText([user('hi'), toolCall, assistant('hello')])).toBe('User: hi\nAssistant: hello');
  });

  it('skips an empty message instead of emitting a turn that said nothing', () => {
    expect(buildResumeHistoryText([user('hi'), assistant('   '), assistant('hello')])).toBe(
      'User: hi\nAssistant: hello'
    );
  });

  it('keeps the most recent turns, not the oldest', () => {
    // A follow-up is about what just happened. Trimming from the wrong end
    // would restore the opening of a long chat and drop its point.
    const many = Array.from({ length: RESUME_HISTORY_MESSAGES + 5 }, (_, i) => user(`turn ${i}`));

    const out = buildResumeHistoryText(many);

    expect(out.split('\n')).toHaveLength(RESUME_HISTORY_MESSAGES);
    expect(out).toContain(`turn ${RESUME_HISTORY_MESSAGES + 4}`);
    expect(out).not.toContain('turn 0');
  });

  it('caps the transcript by characters as well as by turns', () => {
    // One pasted stack trace can be longer than twenty ordinary turns; without
    // the character cap, restoring context is what overflows it.
    const out = buildResumeHistoryText([user('x'.repeat(10_000))], { chars: 500 });

    expect(out).toHaveLength(500);
  });

  it('keeps the end of the transcript when the character cap bites', () => {
    const out = buildResumeHistoryText([user('old'.repeat(200)), assistant('the latest answer')], { chars: 30 });

    expect(out.endsWith('the latest answer')).toBe(true);
  });

  it('treats anything that is not the user as the assistant', () => {
    // `center` and `pop` are system notices; mislabelling one as the user would
    // put words in their mouth.
    expect(buildResumeHistoryText([text('a notice', 'center' as 'left')])).toBe('Assistant: a notice');
  });
});
