/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';

/**
 * A teammate's conversation record, kept current.
 *
 * The team page read this through a plain `useSWR` with nothing subscribed to
 * changes, so the copy it held was whatever the record looked like when the tab
 * was first opened. Pick a different model for a teammate from the header and
 * the send box below it went on showing - and using - the old one, until
 * something unrelated happened to refetch. The user saw their choice apply in
 * one place and not the other, with no way to tell which one the next message
 * would actually use.
 *
 * The main process already announces conversation changes; this just listens.
 * The SWR key is shared with the other readers of the same record, so they
 * revalidate along with it.
 */
export function useTeamConversation(conversationId: string | undefined) {
  const key = conversationId ? (['team-conversation', conversationId] as const) : null;
  const swr = useSWR(key, () => ipcBridge.conversation.get.invoke({ id: conversationId as string }));
  const { mutate } = swr;

  useEffect(() => {
    if (!conversationId) return;
    const unsub = ipcBridge.conversation.listChanged.on((event) => {
      // `created` and `deleted` are the list's business, not this record's.
      if (event?.action !== 'updated') return;
      if (event.conversationId !== conversationId) return;
      void mutate();
    });
    return unsub;
  }, [conversationId, mutate]);

  return swr;
}
