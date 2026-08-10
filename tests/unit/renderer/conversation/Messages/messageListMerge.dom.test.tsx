/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The merge rules the CONVERSATION SURFACE actually runs.
 *
 * There are two message-merge implementations in this codebase and they are
 * not interchangeable. `chatLib.composeMessage` rebuilds a transcript in the
 * main process (`process/utils/message.ts`, `ChannelMessageService.ts`); the
 * renderer runs `composeMessageWithIndex` inside `useAddOrUpdateMessage`, and
 * that function delegates to `composeMessage` for `tool_group` ONLY. A rule
 * proven against `composeMessage` therefore says nothing about what a user
 * sees, which is why this file drives the hook rather than the library.
 *
 * Everything fed in is produced by the REAL `workflow_lifecycle_v1` reducer
 * over the REAL contract fixtures, so a change to the projection's shape shows
 * up here instead of passing against a hand-written stand-in.
 */

import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { useEffect, useRef } from 'react';
import fs from 'node:fs';
import path from 'node:path';

import { createWorkflowLifecycleCapability } from '../../../../../src/process/agent/wcore/capabilities/handlers/workflowLifecycle';
import type {
  CapabilityContext,
  CapabilityStreamFrame,
} from '../../../../../src/process/agent/wcore/capabilities/types';
import { transformMessage } from '../../../../../src/common/chat/chatLib';
import type { TMessage } from '../../../../../src/common/chat/chatLib';
import type { IResponseMessage } from '../../../../../src/common/adapter/ipcBridge';

// `hooks.ts` reaches for the IPC bridge at module scope for the DB hydration
// hook. Nothing here uses that hook, so a hollow bridge is enough to import it.
vi.mock('@/common', () => ({
  ipcBridge: { database: { getConversationMessages: { invoke: () => Promise.resolve([]) } } },
}));

const { MessageListProvider, useMessageList, useAddOrUpdateMessage } =
  await import('../../../../../src/renderer/pages/conversation/Messages/hooks');

const FIXTURES = path.resolve(__dirname, '../../../../fixtures/engine-contract/desktop/v1/events');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf-8')) as Record<string, unknown>;
}

/** Run events through the real reducer and hand back every frame it emitted. */
function reduce(events: Array<Record<string, unknown>>): CapabilityStreamFrame[] {
  const capability = createWorkflowLifecycleCapability();
  const frames: CapabilityStreamFrame[] = [];
  const ctx: CapabilityContext = {
    sendCommand: () => {},
    emit: (frame) => frames.push(frame),
    activeMsgId: () => '',
    log: () => {},
    warn: () => {},
  };
  for (const event of events) capability.handle(event, ctx);
  return frames;
}

function toMessage(frame: CapabilityStreamFrame): TMessage {
  const message = transformMessage({
    type: frame.type,
    data: frame.data,
    msg_id: frame.msg_id,
    conversation_id: 'conv-1',
  } as IResponseMessage);
  expect(message).toBeTruthy();
  return message as TMessage;
}

/**
 * Drive the real hook and expose what the list ended up holding.
 *
 * The hook batches through `setTimeout`, so the assertions wait on the DOM
 * rather than reading a return value - the same asynchrony the surface has.
 */
const Probe: React.FC<{ messages: TMessage[] }> = ({ messages }) => {
  const list = useMessageList();
  const addOrUpdateMessage = useAddOrUpdateMessage();
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    for (const message of messages) addOrUpdateMessage(message);
  }, [messages, addOrUpdateMessage]);

  return (
    <ul data-testid='list' data-count={list.length}>
      {list.map((message, i) => (
        <li
          key={`${message.id}-${i}`}
          data-testid={`row-${i}`}
          data-type={message.type}
          data-msg-id={message.msg_id ?? ''}
        >
          {message.type === 'workflow_run' ? `${message.content.status}:${message.content.nodes.length}` : ''}
        </li>
      ))}
    </ul>
  );
};

function renderList(messages: TMessage[]) {
  return render(
    <MessageListProvider value={[]}>
      <Probe messages={messages} />
    </MessageListProvider>
  );
}

/** Wait until the hook's batched flush has drained every queued message. */
async function settled(expectedCount: number): Promise<HTMLElement> {
  await waitFor(() => {
    expect(screen.getByTestId('list').getAttribute('data-count')).toBe(String(expectedCount));
  });
  return screen.getByTestId('list');
}

afterEach(cleanup);

describe('useAddOrUpdateMessage - workflow_run through the renderer merge path', () => {
  it('collapses every snapshot of one run into a single card carrying the final status', async () => {
    const frames = reduce([fixture('workflow_started'), fixture('workflow_node_event'), fixture('workflow_finished')]);
    expect(frames.length).toBeGreaterThan(1);

    // Agent chatter between snapshots: the run's frames are NOT consecutive in
    // a real transcript, which is why the merge is keyed on runId rather than
    // on "same as the last message?".
    const interleaved: TMessage[] = [];
    frames.forEach((frame, i) => {
      interleaved.push(toMessage(frame));
      interleaved.push(
        toMessage({ type: 'content', data: 'still working', msg_id: `turn-${i}` } as CapabilityStreamFrame)
      );
    });

    renderList(interleaved);

    // 3 chatter messages + exactly 1 run card.
    const list = await settled(frames.length + 1);
    const cards = [...list.children].filter((row) => row.getAttribute('data-type') === 'workflow_run');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toBe('succeeded:1');
  });

  it('never overwrites a message whose msg_id collides with the runId', async () => {
    const frames = reduce([fixture('workflow_started')]);
    const card = toMessage(frames[0]);
    expect(card.msg_id).toBeTruthy();

    // A turn whose msg_id happens to equal this run's id. Nothing stops the
    // two id spaces colliding: `msg_id` is a uuid minted by the send box,
    // `runId` is an engine string, and neither knows about the other.
    const collision = toMessage({
      type: 'content',
      data: 'a message the user actually sent',
      msg_id: card.msg_id,
    } as CapabilityStreamFrame);
    expect(collision.type).toBe('text');

    renderList([collision, card]);

    // Both survive. Without the type guard in the `workflow_run` arm the run
    // snapshot falls into the generic in-place replacement, which spreads the
    // incoming message over the existing one - turning the user's text row
    // into a workflow card and losing the text entirely.
    const list = await settled(2);
    expect(list.children[0].getAttribute('data-type')).toBe('text');
    expect(list.children[1].getAttribute('data-type')).toBe('workflow_run');
  });

  it('replaces the run snapshot wholesale rather than merging node lists', async () => {
    // `workflow_started` reports zero nodes; the node event adds one. If the
    // arm merged field-by-field instead of replacing `content`, a later
    // snapshot that dropped a node would keep showing it.
    const frames = reduce([fixture('workflow_started'), fixture('workflow_node_event')]);
    const first = toMessage(frames[0]);
    const second = toMessage(frames[frames.length - 1]);
    expect(first.msg_id).toBe(second.msg_id);

    renderList([second, { ...first, id: 'replay' } as TMessage]);

    const list = await settled(1);
    // The last snapshot written wins outright - here the run-open one, which
    // reports no nodes at all. A field-by-field merge would leave the node
    // from the earlier snapshot standing.
    expect(list.children[0].getAttribute('data-type')).toBe('workflow_run');
    expect(list.children[0].textContent).toBe('running:0');
  });
});
