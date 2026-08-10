/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One diagnostics round-trip, from the button press to the engine's answer.
 *
 * WHY IT IS A REQUEST AND NOT A SUBSCRIPTION. The engine reports runtime
 * diagnostics only when asked, and until `ipcBridge.wcoreEngine
 * .requestRuntimeDiagnostics` existed nothing in the app could ask - so the
 * Runtime pane's whole diagnostics section was unreachable markup and its empty
 * state said as much ("this build has no way to ask yet").
 *
 * WHY THE REPLY IS CORRELATED RATHER THAN "NEWEST WINS". A snapshot names
 * config paths, ignored environment variables and per-server failures that
 * belong to ONE engine process. Two open chats are two engines and two
 * different answers to the same question, and a readout that takes whichever
 * frame arrived last would silently describe the wrong one. So a frame settles
 * this hook only when it carries BOTH the conversation this hook asked and the
 * `requestId` the main process minted for that ask - the same correlation rule
 * the main-process ledger already applies to the engine's side of the wire.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type { RuntimeDiagnosticsFrame } from '../panes/types';

/** The two frame types the diagnostics round-trip settles on. */
const DIAGNOSTICS_TYPES: ReadonlySet<string> = new Set([
  'runtime_diagnostics_snapshot',
  'runtime_diagnostics_unavailable',
]);

/**
 * A decoded diagnostics frame, or null.
 *
 * Only the discriminant is re-checked. The body was already validated field by
 * field by the main-process handler, which BUILT this object - re-validating the
 * nested snapshot here would be a second decoder to keep in sync with the first,
 * and the two drifting apart is worse than either being wrong alone.
 */
function readDiagnosticsFrame(data: unknown): RuntimeDiagnosticsFrame | null {
  if (typeof data !== 'object' || data === null) return null;
  const { status } = data as { status?: unknown };
  if (status !== 'snapshot' && status !== 'unavailable' && status !== 'undecodable') return null;
  return data as RuntimeDiagnosticsFrame;
}

/** What the pane is allowed to say right now. Never more than one of these. */
export type DiagnosticsPhase =
  /** Nothing has been asked in this mount. */
  | 'idle'
  /** The request is on its way to the main process. */
  | 'asking'
  /** The command reached an engine; its answer is owed. */
  | 'pending'
  /** An answer arrived - snapshot, refusal, or undecodable. */
  | 'settled'
  /** There was no live engine to ask. */
  | 'no_engine'
  /** An engine was there and declined to accept the command. */
  | 'refused';

export type RuntimeDiagnosticsState = {
  phase: DiagnosticsPhase;
  /** The settled reply. Non-null only while `phase === 'settled'`. */
  frame: RuntimeDiagnosticsFrame | null;
  /** The engine this state describes, by conversation. Null before the first ask. */
  conversationId: string | null;
  /** Live Darhai Core engines at the moment of the last ask. */
  engines: number;
  /** The engine layer's own words. Non-null only while `phase === 'refused'`. */
  reason: string | null;
};

const IDLE: RuntimeDiagnosticsState = { phase: 'idle', frame: null, conversationId: null, engines: 0, reason: null };

export type UseRuntimeDiagnostics = RuntimeDiagnosticsState & { ask: () => void };

export function useRuntimeDiagnostics(): UseRuntimeDiagnostics {
  const [state, setState] = useState<RuntimeDiagnosticsState>(IDLE);
  /**
   * The outstanding request, readable from the stream handler.
   *
   * A ref rather than state because the subscription is registered once: a
   * handler closing over `state` would keep comparing against whatever request
   * existed at mount, which is none, and drop every reply.
   */
  const outstanding = useRef<{ conversationId: string; requestId: string } | null>(null);

  useEffect(() => {
    return ipcBridge.conversation.responseStream.on((message) => {
      if (!DIAGNOSTICS_TYPES.has(message.type)) return;
      const frame = readDiagnosticsFrame(message.data);
      if (frame === null) return;
      const pending = outstanding.current;
      // A frame nobody here asked for belongs to whoever did. Dropping it is
      // the honest move: this pane cannot say which engine it describes.
      if (pending === null) return;
      if (message.conversation_id !== pending.conversationId) return;
      if (frame.requestId !== pending.requestId) return;
      outstanding.current = null;
      setState((previous) => ({ ...previous, phase: 'settled', frame, reason: null }));
    });
  }, []);

  useEffect(() => {
    return () => {
      // The reply can no longer land anywhere; stop claiming one is owed.
      outstanding.current = null;
    };
  }, []);

  const ask = useCallback((): void => {
    outstanding.current = null;
    setState((previous) => ({ ...previous, phase: 'asking', frame: null, reason: null }));
    ipcBridge.wcoreEngine.requestRuntimeDiagnostics
      .invoke()
      .then((outcome) => {
        const engines = typeof outcome?.engines === 'number' ? outcome.engines : 0;
        const sent = Array.isArray(outcome?.sent) ? outcome.sent : [];
        const refused = Array.isArray(outcome?.refused) ? outcome.refused : [];
        const accepted = sent.find((entry) => typeof entry.requestId === 'string' && entry.requestId.length > 0);

        if (accepted !== undefined) {
          outstanding.current = { conversationId: accepted.conversationId, requestId: accepted.requestId as string };
          setState({
            phase: 'pending',
            frame: null,
            conversationId: accepted.conversationId,
            engines,
            reason: null,
          });
          return;
        }

        const declined = refused[0];
        if (declined !== undefined) {
          setState({
            phase: 'refused',
            frame: null,
            conversationId: declined.conversationId,
            engines,
            // Never invented: an entry with no reason is reported as no reason.
            reason: typeof declined.reason === 'string' && declined.reason.length > 0 ? declined.reason : null,
          });
          return;
        }

        setState({ phase: 'no_engine', frame: null, conversationId: null, engines, reason: null });
      })
      .catch((error: unknown) => {
        setState({
          phase: 'refused',
          frame: null,
          conversationId: null,
          engines: 0,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  return { ...state, ask };
}
