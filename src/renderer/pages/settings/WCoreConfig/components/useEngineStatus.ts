/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What this surface may honestly say about the engine's state and build.
 *
 * WHY IT EXISTS. The header chip and the Overview "Engine" card were compile-
 * time constants dressed as readings. Both keyed off
 * `acpConversation.getAvailableAgents`, whose wcore entry is built
 * `available: true` unconditionally and carries no `version` field at all - so
 * `engine running · v0.12.26` rendered whether or not an engine process
 * existed, the version was always the pinned constant, and the `stopped` branch
 * could not fire. Meanwhile the Runtime pane one click away correctly said "No
 * Darhai Core chat is open, so there is no engine process to ask."
 *
 * `wcoreEngine.liveness` answers from the same `liveEngines` the diagnostics
 * round-trip counts, so the two panes can no longer contradict each other, and
 * it is PASSIVE - it writes nothing to any engine, which is what makes it legal
 * to call from a status card on mount.
 *
 * WHAT IT STILL CANNOT SEE. An engine that dies while Settings is open. There
 * is no engine-exit event on the renderer's stream, so the count is re-read on
 * mount and whenever a `capability_activation` frame announces a NEW engine
 * starting - which is the case this whole wave existed to fix. Polling for the
 * other direction was rejected: a status card that lies for a second after a
 * crash is a smaller fault than a timer running behind every Settings visit.
 */

import { useEffect, useState } from 'react';
import { ipcBridge } from '@/common';

export type EngineStatus = {
  /** Live Darhai Core engine processes at the last read. */
  engines: number;
  /** Semver from the newest engine's `ready`. `''` when none has reported one. */
  engineVersion: string;
  /** False until the main process answered. Nothing may be claimed before it. */
  settled: boolean;
};

const UNKNOWN: EngineStatus = { engines: 0, engineVersion: '', settled: false };

export function useEngineStatus(): EngineStatus {
  const [status, setStatus] = useState<EngineStatus>(UNKNOWN);

  useEffect(() => {
    let alive = true;

    const read = (): void => {
      ipcBridge.wcoreEngine.liveness
        .invoke()
        .then((result) => {
          if (!alive) return;
          // Re-narrowed rather than trusted: this crosses the IPC seam, and a
          // widened field reaching the chip renders `undefined` beside the
          // product name.
          setStatus({
            engines: typeof result?.engines === 'number' ? result.engines : 0,
            engineVersion: typeof result?.engineVersion === 'string' ? result.engineVersion : '',
            settled: true,
          });
        })
        .catch(() => {
          // Unreadable is not "stopped": `settled` alone flips, so a caller can
          // tell "the engine is not running" from "Darhai could not find out".
          if (alive) setStatus((previous) => ({ ...previous, settled: true }));
        });
    };

    read();
    const off = ipcBridge.conversation.responseStream.on((message) => {
      // An engine that starts while Settings is open announces itself here
      // before anything else reaches the renderer, so this is the earliest
      // honest moment to re-count.
      if (message.type === 'capability_activation') read();
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return status;
}
