/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import type { CreateNoteParams, Note, UpdateNoteParams } from '@/common/types/notes';

/**
 * Notes data layer. Loads the current user's notes (SWR-cached), revalidates on
 * any `note.onNoteChanged` event, and exposes the mutation verbs the page needs.
 * The main process owns persistence + reminders; this hook is a thin IPC client.
 */
export function useNotes(showArchived: boolean) {
  const { user } = useAuth();
  const userId = user?.id ?? '';

  const swrKey = userId ? `notes:${userId}:${showArchived ? 'all' : 'active'}` : null;

  const { data, isLoading, mutate } = useSWR<Note[]>(
    swrKey,
    async () => ipcBridge.note.list.invoke({ userId, includeArchived: showArchived }),
    { revalidateOnFocus: false }
  );

  // Any mutation (from this window or the reminder rollover) refreshes the list.
  useEffect(() => {
    const unsubscribe = ipcBridge.note.onNoteChanged.on(() => {
      void mutate();
    });
    return () => unsubscribe();
  }, [mutate]);

  const notes = data ?? [];

  const createNote = useCallback(
    async (params: Omit<CreateNoteParams, 'userId'>): Promise<Note | null> => {
      if (!userId) return null;
      const note = await ipcBridge.note.create.invoke({ ...params, userId });
      await mutate();
      return note;
    },
    [userId, mutate]
  );

  const updateNote = useCallback(
    async (noteId: string, updates: UpdateNoteParams): Promise<void> => {
      await ipcBridge.note.update.invoke({ noteId, updates });
      await mutate();
    },
    [mutate]
  );

  const deleteNote = useCallback(
    async (noteId: string): Promise<void> => {
      await ipcBridge.note.delete.invoke({ noteId });
      await mutate();
    },
    [mutate]
  );

  const togglePin = useCallback(
    async (noteId: string): Promise<void> => {
      await ipcBridge.note.togglePin.invoke({ noteId });
      await mutate();
    },
    [mutate]
  );

  const toggleArchive = useCallback(
    async (noteId: string): Promise<void> => {
      await ipcBridge.note.toggleArchive.invoke({ noteId });
      await mutate();
    },
    [mutate]
  );

  const toggleItem = useCallback(
    async (noteId: string, index: number): Promise<void> => {
      await ipcBridge.note.toggleItem.invoke({ noteId, index });
      await mutate();
    },
    [mutate]
  );

  return {
    userId,
    notes,
    isLoading,
    refresh: mutate,
    createNote,
    updateNote,
    deleteNote,
    togglePin,
    toggleArchive,
    toggleItem,
  };
}
