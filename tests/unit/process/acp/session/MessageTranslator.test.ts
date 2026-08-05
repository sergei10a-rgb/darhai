// tests/unit/process/acp/session/MessageTranslator.test.ts
import { describe, it, expect } from 'vitest';
import { MessageTranslator } from '@process/acp/session/MessageTranslator';
import type { SessionNotification } from '@agentclientprotocol/sdk';

describe('MessageTranslator', () => {
  it('translates agent_message_chunk to TMessage', () => {
    const translator = new MessageTranslator();
    const notification: SessionNotification = {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-1',
        content: { type: 'text', text: 'Hello' },
      },
    };
    const messages = translator.translate(notification);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].type).toBeDefined();
  });

  it('accumulates chunks for same messageId', () => {
    const translator = new MessageTranslator();
    translator.translate({
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'Hello ' },
      },
    });
    const msgs = translator.translate({
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'world' },
      },
    });
    expect(msgs.length).toBeGreaterThanOrEqual(1);
  });

  it('translates tool_call to TMessage', () => {
    const translator = new MessageTranslator();
    const messages = translator.translate({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'read_file',
        rawInput: { path: '/foo' },
      },
    });
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it('onTurnEnd clears completed entries (INV-S-12)', () => {
    const translator = new MessageTranslator();
    translator.translate({
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'test' },
      },
    });
    expect(translator.activeEntryCount).toBeGreaterThan(0);
    translator.onTurnEnd();
    expect(translator.activeEntryCount).toBe(0);
  });

  it('reset clears all state', () => {
    const translator = new MessageTranslator();
    translator.translate({
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'test' },
      },
    });
    translator.reset();
    expect(translator.activeEntryCount).toBe(0);
  });

  it('returns empty array for config-type updates (handled by AcpSession directly)', () => {
    const translator = new MessageTranslator();
    const msgs = translator.translate({
      sessionId: 's1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
    });
    expect(msgs).toEqual([]);
  });
});

describe('MessageTranslator - streamed text is not doubled', () => {
  /**
   * The exact shape claude-code-acp emits: fragments with NO messageId, then the
   * whole message repeated once under a real one. Bucketing those separately is
   * what turned a one-word reply into "PongPong" - and since the doubled text is
   * what gets persisted, it spread into conversation history and memory rather
   * than staying a display glitch.
   */
  const chunk = (text: string, messageId?: string): SessionNotification =>
    ({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } },
    }) as SessionNotification;

  const thought = (text: string, messageId?: string): SessionNotification =>
    ({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text } },
    }) as SessionNotification;

  /** Everything the renderer would append, in order. */
  const emitted = (translator: MessageTranslator, notifications: SessionNotification[]): string =>
    notifications
      .flatMap((n) => translator.translate(n))
      .map((m) => (m.content as { content?: string }).content ?? '')
      .join('');

  it('does not repeat a message re-sent in full under a real id', () => {
    const translator = new MessageTranslator();

    const text = emitted(translator, [chunk('Pong'), chunk('Pong', 'msg-1')]);

    expect(text).toBe('Pong');
  });

  it('handles the full streamed-then-restated sequence', () => {
    const translator = new MessageTranslator();

    const text = emitted(translator, [
      chunk('The '),
      chunk('answer '),
      chunk('is 42.'),
      chunk('The answer is 42.', 'msg-1'),
    ]);

    expect(text).toBe('The answer is 42.');
  });

  it('emits only the tail when a restatement carries new text', () => {
    const translator = new MessageTranslator();

    const text = emitted(translator, [chunk('Hello'), chunk('Hello world', 'msg-1')]);

    expect(text).toBe('Hello world');
  });

  it('still appends genuine incremental fragments', () => {
    // The other streaming shape must keep working: nothing here restates, so
    // every chunk is new text.
    const translator = new MessageTranslator();

    const text = emitted(translator, [chunk('a', 'm1'), chunk('b', 'm1'), chunk('c', 'm1')]);

    expect(text).toBe('abc');
  });

  it('does not merge two genuinely different messages', () => {
    // Guard against over-merging: a second message that does not continue the
    // first must stay its own message.
    const translator = new MessageTranslator();
    const first = translator.translate(chunk('First.', 'm1'));
    const second = translator.translate(chunk('Second.', 'm2'));

    expect((first[0].content as { content: string }).content).toBe('First.');
    expect((second[0].content as { content: string }).content).toBe('Second.');
    expect(second[0].msg_id).not.toBe(first[0].msg_id);
  });

  it('applies the same rule to thinking chunks', () => {
    const translator = new MessageTranslator();

    const text = emitted(translator, [thought('Think'), thought('Think', 'msg-1')]);

    expect(text).toBe('Think');
  });

  it('repeats an identical reply in the next turn rather than swallowing it', () => {
    const translator = new MessageTranslator();
    emitted(translator, [chunk('Pong'), chunk('Pong', 'msg-1')]);
    translator.onTurnEnd();

    expect(emitted(translator, [chunk('Pong')])).toBe('Pong');
  });

  it('lets go of the accumulated text at the end of a turn', () => {
    // This is what `onTurnEnd` clearing the accumulator is actually for. A stale
    // entry can never produce a wrong delta - the next turn mints fresh msg_ids -
    // so the only cost is that a long session would hold on to the full text of
    // every message it ever streamed. Asserted separately from the behaviour
    // above, which passes with or without the clear.
    const translator = new MessageTranslator();
    emitted(translator, [chunk('Pong'), chunk('Pong', 'msg-1')]);
    expect(translator.accumulatedEntryCount).toBeGreaterThan(0);

    translator.onTurnEnd();

    expect(translator.accumulatedEntryCount).toBe(0);
  });

  it('starts fresh after a tool call interrupts the stream', () => {
    const translator = new MessageTranslator();
    emitted(translator, [chunk('Working')]);
    translator.translate({
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', status: 'pending' },
    } as SessionNotification);

    expect(emitted(translator, [chunk('Working')])).toBe('Working');
  });

  it('lets go of the accumulated text when a tool call interrupts', () => {
    // Same reasoning as the turn-end case: the behaviour above passes with or
    // without the clear, so the release is asserted on its own.
    const translator = new MessageTranslator();
    emitted(translator, [chunk('Working')]);
    expect(translator.accumulatedEntryCount).toBeGreaterThan(0);

    translator.translate({
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', status: 'pending' },
    } as SessionNotification);

    expect(translator.accumulatedEntryCount).toBe(0);
  });
});
