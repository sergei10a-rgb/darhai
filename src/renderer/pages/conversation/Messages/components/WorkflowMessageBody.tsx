/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WorkflowMessageBody — thin adapter that routes an assistant message body
 * through `WorkflowAwareMessage` when the enclosing conversation belongs to
 * a workflow session.
 *
 * Workflow conversations set `workflowSessionId` in `ConversationContext`.
 * When present, this component:
 *   - Passes the body through the AST-authoritative finalize() pass so
 *     `<step>` and `<ask>` markers are stripped before the markdown renderer
 *     sees the text.
 *   - Fires `useWorkflowSession.applyStepMarker(n, status, 'parent')` for
 *     every `step` marker the parser extracts.
 *   - No-ops `ask` markers for v1 (the WorkflowSurface AskCard handles them
 *     via IPC-pushed session state; the parser result here is informational).
 *
 * Non-workflow conversations (no `workflowSessionId`) are a zero-overhead
 * pass-through: children receives the body verbatim and no IPC is touched.
 *
 * `totalSteps` is derived from the session data held by `useWorkflowSession`.
 * Before the session loads, it falls back to a permissive ceiling (999) so
 * markers with any valid step number are accepted rather than silently
 * discarded while the initial IPC fetch is in flight.
 *
 * Spec: .planning/brainstorm/2026-05-25-workflow-launch-surface/SPEC.md §8, §11.2
 */

import React, { useCallback } from 'react';
import { WorkflowAwareMessage } from '@/renderer/pages/guid/components/workflow/WorkflowAwareMessage';
import { useWorkflowSession } from '@/renderer/hooks/workflow/useWorkflowSession';
import type { WorkflowMarker } from '@/common/types/workflowTypes';

/** Fallback ceiling used before the session data resolves. */
const UNLOADED_TOTAL_STEPS = 999;

export type WorkflowMessageBodyProps = {
  /** Workflow session ID from ConversationContext, or undefined for non-workflow conversations. */
  workflowSessionId: string | undefined;
  /** Full (possibly marker-bearing) message body string. */
  body: string;
  /** Render the (possibly-stripped) body. Called with the cleaned text. */
  children: (cleanedBody: string) => React.ReactNode;
};

/**
 * Routes an assistant message body through WorkflowAwareMessage when the
 * conversation has a workflow session, so step markers are stripped from the
 * rendered text and forwarded into session rail state via applyStepMarker.
 * Pass-through for non-workflow conversations.
 */
export const WorkflowMessageBody: React.FC<WorkflowMessageBodyProps> = ({ workflowSessionId, body, children }) => {
  const session = useWorkflowSession(workflowSessionId, undefined);
  const totalSteps = session.data?.total_steps ?? UNLOADED_TOTAL_STEPS;

  const handleMarker = useCallback(
    (marker: WorkflowMarker) => {
      if (!workflowSessionId) return;
      if (marker.kind === 'step') {
        void session.applyStepMarker(marker.n, marker.status, 'parent');
      }
      // ask markers are no-op for v1 — WorkflowSurface reads asks from
      // IPC-pushed session state, not from the message body.
    },
    [session, workflowSessionId]
  );

  if (!workflowSessionId) {
    return <>{children(body)}</>;
  }

  return (
    <WorkflowAwareMessage body={body} totalSteps={totalSteps} onMarker={handleMarker}>
      {(cleanedBody) => <>{children(cleanedBody)}</>}
    </WorkflowAwareMessage>
  );
};
