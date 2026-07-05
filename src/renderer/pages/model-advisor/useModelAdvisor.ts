/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { HwfitHardware, HwfitRankOptions, HwfitResult, HwfitUseCase } from '@/common/types/hwfit';

/**
 * Loads the detected hardware once, then ranks the catalog whenever the
 * use-case, filters, or simulated-rig override change. Ranking runs in the main
 * process (pure fit-scoring over the bundled catalog), so the renderer stays
 * responsive - SWR dedupes and caches each distinct query.
 */
export function useModelAdvisor() {
  const [useCase, setUseCase] = useState<HwfitUseCase>('general');
  const [search, setSearch] = useState('');
  const [fitOnly, setFitOnly] = useState(false);
  const [override, setOverride] = useState<HwfitHardware | null>(null);

  const {
    data: hardware,
    isLoading: hardwareLoading,
    mutate: mutateHardware,
  } = useSWR<HwfitHardware>('hwfit/hardware', () => ipcBridge.hwfit.scanHardware.invoke({}), {
    revalidateOnFocus: false,
  });

  const { data: catalogSize } = useSWR<number>('hwfit/catalog-size', () => ipcBridge.hwfit.catalogSize.invoke(), {
    revalidateOnFocus: false,
  });

  // A stable cache key for the current ranking query. The override (when set)
  // is part of the key so switching simulated rigs refetches.
  const rankKey = useMemo(() => {
    const rigTag = override
      ? `${override.gpuName}:${override.gpuVramGb}:${override.gpuCount}:${override.gpuOnly}`
      : 'auto';
    return `hwfit/rank/${useCase}/${fitOnly}/${rigTag}`;
  }, [useCase, fitOnly, override]);

  const { data: results, isLoading: rankLoading } = useSWR<HwfitResult[]>(
    // Only rank once we know the hardware (or have an override).
    hardware || override ? rankKey : null,
    () => {
      const options: HwfitRankOptions = {
        useCase,
        fitOnly,
        sort: 'score',
        limit: 60,
      };
      if (override) options.hardwareOverride = override;
      return ipcBridge.hwfit.rankModels.invoke(options);
    },
    { revalidateOnFocus: false, keepPreviousData: true }
  );

  const rescan = useCallback(async (): Promise<void> => {
    await ipcBridge.hwfit.scanHardware.invoke({ fresh: true });
    await mutateHardware();
  }, [mutateHardware]);

  // Client-side search filter over the ranked results (keeps the query key
  // small and avoids a round-trip per keystroke).
  const filtered = useMemo(() => {
    const list = results ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => r.name.toLowerCase().includes(q) || r.provider.toLowerCase().includes(q));
  }, [results, search]);

  return {
    hardware,
    hardwareLoading,
    catalogSize: catalogSize ?? 0,
    results: filtered,
    totalResults: (results ?? []).length,
    rankLoading,
    useCase,
    setUseCase,
    search,
    setSearch,
    fitOnly,
    setFitOnly,
    override,
    setOverride,
    rescan,
  };
}
