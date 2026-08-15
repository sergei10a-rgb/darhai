/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type {
  CookbookBackend,
  CookbookBackendSelection,
  CookbookDownloadInfo,
  CookbookDownloadProgress,
  CookbookServeStatus,
} from '@/common/types/cookbook';

const IDLE_STATUS: CookbookServeStatus = {
  state: 'idle',
  modelId: null,
  backend: 'none',
  port: null,
  providerId: null,
  servedModel: null,
};

const EMPTY_SELECTION: CookbookBackendSelection = { chosen: 'none', viable: [], provisionable: [] };

/** State + actions for the cookbook download/serve controls in the advisor. */
export type CookbookController = {
  /** Raw installed backend probe (locate / degraded affordance). */
  backend: CookbookBackend;
  /** Hardware-adaptive backend choice: default-selected + viable overrides. */
  selection: CookbookBackendSelection;
  serveStatus: CookbookServeStatus;
  /** Per-model download state, keyed by model id. */
  downloads: Record<string, CookbookDownloadInfo>;
  /** Live per-model download progress, keyed by model id. */
  progress: Record<string, CookbookDownloadProgress>;
  download: (modelId: string) => Promise<void>;
  cancelDownload: (modelId: string) => Promise<void>;
  /** Serve via the hardware-chosen backend, or an explicit viable override. */
  serve: (modelId: string, backend?: CookbookBackend) => Promise<void>;
  stopServe: () => Promise<void>;
  locateBackend: () => Promise<void>;
  /**
   * Re-probe which backends are installed. Call this after Darhai provisions
   * its own llama.cpp: the SWR caches below were populated when no backend
   * existed, so without a refresh the row would still think it must fall back
   * to the copy-a-command path a moment after the binary landed.
   */
  refreshBackends: () => Promise<void>;
};

/**
 * Drives the cookbook-serve surface: loads the download cache + serve status +
 * detected backend, streams download progress + serve-status changes over IPC,
 * and exposes the download / serve / stop / locate actions the table renders.
 * All verbs are remote-denied main-side; this hook only runs in the trusted
 * local renderer.
 */
export function useCookbookServe(): CookbookController {
  const { data: downloadsList, mutate: mutateDownloads } = useSWR<CookbookDownloadInfo[]>(
    'cookbook/downloads',
    () => ipcBridge.cookbook.listDownloads.invoke(),
    { revalidateOnFocus: false }
  );
  const { data: installedBackend, mutate: mutateBackend } = useSWR<CookbookBackend>(
    'cookbook/backend',
    () => ipcBridge.cookbook.detectBackend.invoke(),
    { revalidateOnFocus: false }
  );
  const { data: selection, mutate: mutateSelection } = useSWR<CookbookBackendSelection>(
    'cookbook/backend-options',
    () => ipcBridge.cookbook.backendOptions.invoke(),
    { revalidateOnFocus: false }
  );

  const [serveStatus, setServeStatus] = useState<CookbookServeStatus>(IDLE_STATUS);
  const [progress, setProgress] = useState<Record<string, CookbookDownloadProgress>>({});

  // Seed the current serve status once on mount.
  useEffect(() => {
    let alive = true;
    void ipcBridge.cookbook.serveStatus.invoke().then((s) => {
      if (alive) setServeStatus(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Live download progress + serve-status changes.
  useEffect(() => {
    const offProgress = ipcBridge.cookbook.onDownloadProgress.on((p: CookbookDownloadProgress) => {
      setProgress((prev) => ({ ...prev, [p.modelId]: p }));
    });
    const offStatus = ipcBridge.cookbook.onServeStatus.on((s: CookbookServeStatus) => {
      setServeStatus(s);
      // A serve transition off 'downloading' means the cache changed.
      if (s.state !== 'downloading' && s.state !== 'starting') void mutateDownloads();
    });
    return () => {
      offProgress();
      offStatus();
    };
  }, [mutateDownloads]);

  const download = useCallback(
    async (modelId: string): Promise<void> => {
      await ipcBridge.cookbook.download.invoke({ modelId });
      setProgress((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
      await mutateDownloads();
    },
    [mutateDownloads]
  );

  const cancelDownload = useCallback(
    async (modelId: string): Promise<void> => {
      await ipcBridge.cookbook.cancelDownload.invoke({ modelId });
      setProgress((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
      await mutateDownloads();
    },
    [mutateDownloads]
  );

  const serve = useCallback(
    async (modelId: string, backend?: CookbookBackend): Promise<void> => {
      const status = await ipcBridge.cookbook.serve.invoke({ modelId, backend });
      setServeStatus(status);
      await mutateDownloads();
    },
    [mutateDownloads]
  );

  const stopServe = useCallback(async (): Promise<void> => {
    const status = await ipcBridge.cookbook.stopServe.invoke();
    setServeStatus(status);
  }, []);

  const refreshBackends = useCallback(async (): Promise<void> => {
    await Promise.all([mutateBackend(), mutateSelection()]);
  }, [mutateBackend, mutateSelection]);

  const locateBackend = useCallback(async (): Promise<void> => {
    const picked = await ipcBridge.dialog.showOpen.invoke({ properties: ['openFile'] });
    const path = picked?.[0];
    if (!path) return;
    await ipcBridge.cookbook.locateBackend.invoke({ path });
    await Promise.all([mutateBackend(), mutateSelection()]);
  }, [mutateBackend, mutateSelection]);

  const downloads = useMemo<Record<string, CookbookDownloadInfo>>(() => {
    const map: Record<string, CookbookDownloadInfo> = {};
    for (const d of downloadsList ?? []) map[d.modelId] = d;
    return map;
  }, [downloadsList]);

  return {
    backend: installedBackend ?? 'none',
    selection: selection ?? EMPTY_SELECTION,
    serveStatus,
    downloads,
    progress,
    download,
    cancelDownload,
    serve,
    stopServe,
    locateBackend,
    refreshBackends,
  };
}
