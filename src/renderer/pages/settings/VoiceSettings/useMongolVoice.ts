/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * State + actions for the Mongolian voice install card: loads the component
 * status, streams install progress over IPC (the cookbook onDownloadProgress
 * pattern), and exposes installAll / cancelInstall.
 *
 * Installs run SEQUENTIALLY through the missing components - the payloads
 * total ~1.7 GB, so two concurrent downloads would just split the same pipe -
 * and the whole run stops on the first failure so one error is reported once,
 * not echoed by every component after it.
 */

import { useCallback, useEffect, useState } from 'react';
import { mongolVoice } from '@/common/adapter/ipcBridge';
import { MONGOL_VOICE_COMPONENTS } from '@/common/types/mongolVoice';
import type {
  MongolVoiceComponent,
  MongolVoiceComponentStatus,
  MongolVoiceInstallProgress,
  MongolVoiceStatusView,
} from '@/common/types/mongolVoice';

/** Provisioner component id -> key inside the status view's `components`. */
export const VIEW_KEY_BY_COMPONENT: Record<MongolVoiceComponent, keyof MongolVoiceStatusView['components']> = {
  'stt-runtime': 'sttRuntime',
  'stt-model': 'sttModel',
  'tts-bundle': 'ttsBundle',
};

/** One component's slice of the status view. */
export function componentState(
  view: MongolVoiceStatusView,
  component: MongolVoiceComponent
): MongolVoiceComponentStatus {
  return view.components[VIEW_KEY_BY_COMPONENT[component]];
}

export type MongolVoiceController = {
  /** Null until the first status fetch resolves. */
  status: MongolVoiceStatusView | null;
  /** Live per-component install progress, keyed by component id. */
  progress: Partial<Record<MongolVoiceComponent, MongolVoiceInstallProgress>>;
  /** True while installAll is walking the missing components. */
  installing: boolean;
  /** Sticky last failure; cleared when a new install starts. */
  error: { code: string; message: string } | null;
  installAll: () => Promise<void>;
  cancelInstall: () => Promise<void>;
  refresh: () => Promise<void>;
};

export function useMongolVoice(): MongolVoiceController {
  const [status, setStatus] = useState<MongolVoiceStatusView | null>(null);
  const [progress, setProgress] = useState<Partial<Record<MongolVoiceComponent, MongolVoiceInstallProgress>>>({});
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const next = await mongolVoice.status.invoke().catch((): null => null);
    if (next !== null) setStatus(next);
  }, []);

  // Seed the status once on mount.
  useEffect(() => {
    let alive = true;
    void mongolVoice.status.invoke().then(
      (s) => {
        if (alive) setStatus(s);
      },
      () => {
        // Bridge unavailable (e.g. WebUI): leave status null; the card renders nothing.
      }
    );
    return () => {
      alive = false;
    };
  }, []);

  // Live install progress (cookbook's onDownloadProgress subscription shape).
  useEffect(() => {
    const off = mongolVoice.onProgress.on((p: MongolVoiceInstallProgress) => {
      setProgress((prev) => ({ ...prev, [p.component]: p }));
    });
    return off;
  }, []);

  const installAll = useCallback(async (): Promise<void> => {
    setError(null);
    setInstalling(true);
    try {
      // Re-read rather than trusting React state: the press may be seconds
      // after the last fetch, and installing an already-installed component
      // is harmless but downloading one that just appeared is wasted bytes.
      const current = await mongolVoice.status.invoke();
      setStatus(current);
      for (const component of MONGOL_VOICE_COMPONENTS) {
        const state = componentState(current, component);
        if (state.installed === true || state.supported === false) continue;
        // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: the payloads share one pipe, and one failure must stop the run
        const result = await mongolVoice.install.invoke({ component });
        if (result.ok === false) {
          // A user cancel is not an error - the card just returns to idle.
          if (result.errorCode !== 'VOICE_CANCELLED') {
            setError({ code: result.errorCode ?? 'VOICE_UNKNOWN', message: result.errorMessage ?? '' });
          }
          break;
        }
      }
    } catch (err) {
      setError({ code: 'VOICE_UNKNOWN', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setInstalling(false);
      setProgress({});
      await refresh();
    }
  }, [refresh]);

  const cancelInstall = useCallback(async (): Promise<void> => {
    // Cancel every component: only the in-flight one answers `cancelled: true`,
    // the rest are no-ops, and this avoids tracking which one is downloading.
    await Promise.all(
      MONGOL_VOICE_COMPONENTS.map((component) =>
        mongolVoice.cancel.invoke({ component }).catch((): undefined => undefined)
      )
    );
  }, []);

  return { status, progress, installing, error, installAll, cancelInstall, refresh };
}
