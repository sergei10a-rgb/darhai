// src/renderer/pages/team/hooks/useTeamList.ts
import { ipcBridge } from '@/common';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import type { TTeam } from '@/common/types/teamTypes';
import { useCallback, useEffect } from 'react';
import useSWR from 'swr';

export function useTeamList() {
  const { user } = useAuth();
  const userId = user?.id ?? 'system_default_user';

  const { data, mutate } = useSWR<TTeam[]>(`teams/${userId}`, () => ipcBridge.team.list.invoke({ userId }), {
    revalidateOnFocus: false,
  });

  // Coerced HERE, not at each consumer. SWR's `= []` default only fires on
  // `undefined`, so a malformed non-array answer from the bridge went straight
  // through to `teams.reduce(...)` in the always-mounted sidebar - and with no
  // error boundary between that and the root, the whole app went white. Four
  // components read this hook; one guard covers them all, and a new consumer
  // cannot forget it.
  const teams = Array.isArray(data) ? data : [];

  // Refresh list when backend creates/removes a team (e.g. via MCP)
  useEffect(() => {
    return ipcBridge.team.listChanged.on(() => {
      void mutate();
    });
  }, [mutate]);

  const removeTeam = useCallback(
    async (id: string) => {
      await ipcBridge.team.remove.invoke({ id });
      localStorage.removeItem(`team-active-slot-${id}`);
      await mutate();
    },
    [mutate]
  );

  return { teams, mutate, removeTeam };
}
