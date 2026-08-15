/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import { ipcBridge } from '@/common';
import type { LlamaRuntimePlan, LlamaRuntimeStatus } from '@/common/types/llamacpp';

/**
 * The first frame, before the main process has answered. `'unknown'` is the
 * only value the renderer invents; everything after it is a fact from disk.
 */
const UNKNOWN_STATUS: LlamaRuntimeStatus = {
  state: 'unknown',
  tag: null,
  serverPath: null,
  acceleration: null,
  fallbackCode: null,
  progress: null,
  errorCode: null,
  errorMessage: null,
};

/** State + actions for Darhai's own llama.cpp runtime. */
export type LlamaRuntimeUiController = {
  status: LlamaRuntimeStatus;
  /**
   * What an install would fetch. Called BEFORE the download so the UI can state
   * the acceleration, the reason it is weaker than the hardware, and the size.
   */
  fetchPlan: () => Promise<LlamaRuntimePlan>;
  /** Download + install. Resolves with the final status (ready or failed). */
  install: () => Promise<LlamaRuntimeStatus>;
  /**
   * Abort an in-flight install. Resolves false when there was nothing to abort
   * yet - the provisioner only owns a transfer after the release lookup - and
   * the UI must say so rather than leave a button that silently did nothing.
   */
  cancel: () => Promise<boolean>;
};

/**
 * Tracks whether Darhai's own `llama-server` exists, and drives installing it.
 *
 * There is exactly one runtime per machine, so this hook is mounted once by the
 * advisor page and the controller is handed down to every row - a per-row hook
 * would open one status subscription per visible model.
 *
 * The whole `llamaRuntime.*` namespace is remote-denied main-side; this hook
 * only ever runs in the trusted local renderer.
 */
export function useLlamaRuntime(): LlamaRuntimeUiController {
  const [status, setStatus] = useState<LlamaRuntimeStatus>(UNKNOWN_STATUS);

  // Seed once on mount, then follow the pushed frames. The subscription is
  // opened FIRST and `pushed` guards the seed, so a slow seed that resolves
  // after a live frame cannot roll the UI back to a stale snapshot.
  useEffect(() => {
    let mounted = true;
    let pushed = false;
    const off = ipcBridge.llamaRuntime.onStatus.on((s: LlamaRuntimeStatus) => {
      pushed = true;
      if (mounted === true) setStatus(s);
    });
    void ipcBridge.llamaRuntime.status.invoke().then((s) => {
      if (mounted === true && pushed === false) setStatus(s);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  const fetchPlan = useCallback((): Promise<LlamaRuntimePlan> => {
    return ipcBridge.llamaRuntime.plan.invoke();
  }, []);

  const install = useCallback(async (): Promise<LlamaRuntimeStatus> => {
    const final = await ipcBridge.llamaRuntime.install.invoke();
    setStatus(final);
    return final;
  }, []);

  const cancel = useCallback(async (): Promise<boolean> => {
    const result = await ipcBridge.llamaRuntime.cancel.invoke();
    return result.cancelled === true;
  }, []);

  return { status, fetchPlan, install, cancel };
}
