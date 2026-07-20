/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import type { ResearchRun, StartResearchParams } from '@/common/types/research';

/**
 * Deep Research data layer for the workspace. Loads the current user's recent runs
 * (SWR-cached), tracks the currently-viewed run, and revalidates both on every
 * `research.onRunChanged` event so the progress rail + report refresh as the loop
 * advances. The main process owns the loop, persistence, and the model/search
 * calls; this hook is a thin IPC client.
 */
export function useResearch() {
  const { user } = useAuth();
  const userId = user?.id ?? '';

  const listKey = userId ? `research:list:${userId}` : null;
  const { data: runs, mutate: mutateRuns } = useSWR<ResearchRun[]>(
    listKey,
    async () => ipcBridge.research.listRuns.invoke({ userId }),
    { revalidateOnFocus: false }
  );

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const runKey = activeRunId ? `research:run:${activeRunId}` : null;
  const { data: activeRun, mutate: mutateRun } = useSWR<ResearchRun | null>(
    runKey,
    async () => (activeRunId ? ipcBridge.research.getRun.invoke({ runId: activeRunId }) : null),
    { revalidateOnFocus: false }
  );

  // Any status change (this window or the background loop) refreshes the list,
  // and the open run when it is the one that changed.
  useEffect(() => {
    const unsubscribe = ipcBridge.research.onRunChanged.on((event) => {
      void mutateRuns();
      if (event.runId === activeRunId) void mutateRun();
    });
    return () => unsubscribe();
  }, [mutateRuns, mutateRun, activeRunId]);

  const start = useCallback(
    async (params: StartResearchParams): Promise<string | null> => {
      if (!userId || params.query.trim().length === 0) return null;
      const { runId } = await ipcBridge.research.start.invoke({ userId, params });
      setActiveRunId(runId);
      await mutateRuns();
      return runId;
    },
    [userId, mutateRuns]
  );

  const cancel = useCallback(async (runId: string): Promise<void> => {
    await ipcBridge.research.cancel.invoke({ runId });
  }, []);

  const selectRun = useCallback((runId: string): void => {
    setActiveRunId(runId);
  }, []);

  return {
    userId,
    runs: runs ?? [],
    activeRun: activeRun ?? null,
    activeRunId,
    start,
    cancel,
    selectRun,
  };
}
