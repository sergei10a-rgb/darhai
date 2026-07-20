/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import type { CalendarOccurrence, CreateCalendarEventParams, UpdateCalendarEventParams } from '@/common/types/calendar';

const DAY = 86_400_000;
/** Grid padding: month panels show trailing/leading days from adjacent months. */
const GRID_PAD_MS = 7 * DAY;

/**
 * Calendar data layer for one visible month. Loads the current user's
 * occurrences for the month's padded range (SWR-cached), revalidates on any
 * `calendar.onEventChanged` event, and exposes the mutation verbs the page
 * needs. The main process owns persistence + reminders + recurrence expansion;
 * this hook is a thin IPC client.
 */
export function useCalendar(anchorMs: number) {
  const { user } = useAuth();
  const userId = user?.id ?? '';

  const anchor = new Date(anchorMs);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  // Fetch the whole month plus a week of padding each side to cover the grid.
  const rangeStartMs = new Date(year, month, 1).getTime() - GRID_PAD_MS;
  const rangeEndMs = new Date(year, month + 1, 1).getTime() + GRID_PAD_MS;

  const swrKey = userId ? `calendar:${userId}:${year}-${month}` : null;

  const { data, isLoading, mutate } = useSWR<CalendarOccurrence[]>(
    swrKey,
    async () => ipcBridge.calendar.list.invoke({ userId, startMs: rangeStartMs, endMs: rangeEndMs }),
    { revalidateOnFocus: false }
  );

  // Any mutation (from this window or the reminder rollover) refreshes the list.
  useEffect(() => {
    const unsubscribe = ipcBridge.calendar.onEventChanged.on(() => {
      void mutate();
    });
    return () => unsubscribe();
  }, [mutate]);

  const occurrences = data ?? [];

  const createEvent = useCallback(
    async (params: Omit<CreateCalendarEventParams, 'userId'>): Promise<void> => {
      if (!userId) return;
      await ipcBridge.calendar.create.invoke({ ...params, userId });
      await mutate();
    },
    [userId, mutate]
  );

  const updateEvent = useCallback(
    async (eventId: string, updates: UpdateCalendarEventParams): Promise<void> => {
      await ipcBridge.calendar.update.invoke({ eventId, updates });
      await mutate();
    },
    [mutate]
  );

  const deleteEvent = useCallback(
    async (eventId: string): Promise<void> => {
      await ipcBridge.calendar.delete.invoke({ eventId });
      await mutate();
    },
    [mutate]
  );

  return {
    userId,
    occurrences,
    isLoading,
    refresh: mutate,
    createEvent,
    updateEvent,
    deleteEvent,
  };
}
