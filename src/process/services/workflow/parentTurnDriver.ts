/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The PARENT workflow driver HAND (Phase 2a).
 *
 * `WorkflowSessionService.continueRun` is the BRAIN: given a workflow session
 * whose parent conversation just finished a turn, it decides what to do
 * (`advance` | `await_input` | `complete` | `halt`) and applies the safe state
 * transition, returning the next-step `directive` when (and only when) the
 * decision is `advance`. This module is the HAND that the `turnCompleted`
 * listener in `initBridge` delegates to - it performs the actual send.
 *
 * Routing rules (the listener is shared with the autonomous-CHILD path):
 *  - Only terminal turn states (`ai_waiting_input` | `stopped` | `error`) act.
 *  - An autonomous-CHILD conversation (carries `extra.autonomousDispatch`) is
 *    NOT a parent run - the existing child-completion branch owns it. We skip
 *    so a conversation is handled by exactly one path.
 *  - Otherwise the conversation is mapped to its workflow session via
 *    `findByConversationId`. No session → not a workflow conversation → skip.
 *  - On `advance` with a directive, send the directive into the same
 *    conversation to drive the next step.
 *
 * All failures are swallowed: a malformed event or a transient send error must
 * never break the user's parent chat.
 */

import type { IConversationTurnCompletedEvent } from '@/common/adapter/ipcBridge';
import type { WorkflowSession } from '@/common/types/workflowTypes';
import type { AfterTurnDecision } from './runDriver';
import type { TurnState } from './WorkflowSessionService';

/** The slice of WorkflowSessionService the parent hand needs. */
export type ParentTurnService = {
  findByConversationId(conversationId: string): WorkflowSession | null;
  continueRun(
    sessionId: string,
    opts?: { repokeActiveStep?: boolean; turnState?: TurnState }
  ): Promise<{
    decision: AfterTurnDecision;
    directive: string | null;
    session: WorkflowSession;
  }>;
  setRunMode(sessionId: string, mode: WorkflowSession['run_mode']): Promise<WorkflowSession>;
};

export type ParentTurnDeps = {
  service: ParentTurnService;
  /**
   * True when the conversation is an autonomous CHILD (the existing
   * child-completion listener owns it). Async because the production
   * implementation reads the conversation row to inspect
   * `extra.autonomousDispatch`.
   */
  isAutonomousChild(conversationId: string): Promise<boolean>;
  /** The HAND: send the next-step directive into the parent conversation. */
  sendDirective(conversationId: string, directive: string): Promise<void>;
};

/** Turn states that mean "the agent finished and is idle" - the only ones we drive on. */
const TERMINAL_TURN_STATES: ReadonlySet<IConversationTurnCompletedEvent['state']> = new Set([
  'ai_waiting_input',
  'stopped',
  'error',
]);

/**
 * Drive the parent workflow run forward after a `turnCompleted` event.
 * Best-effort and self-contained: returns without throwing on any error.
 */
export async function handleParentWorkflowTurn(
  event: IConversationTurnCompletedEvent,
  deps: ParentTurnDeps
): Promise<void> {
  const conversationId = event.sessionId;
  if (!conversationId) return;
  if (!TERMINAL_TURN_STATES.has(event.state)) return;

  try {
    // A conversation is either a parent workflow OR an autonomous child, never
    // both. Defer to the child path when it owns the conversation.
    if (await deps.isAutonomousChild(conversationId)) return;

    const session = deps.service.findByConversationId(conversationId);
    if (session === null) return;

    // Thread the completed turn's terminal state into the brain. Only the three
    // states in TERMINAL_TURN_STATES reach here (guarded above), and they map
    // 1:1 onto the narrowed TurnState union the completion block keys off.
    const turnState = event.state as TurnState;
    const { decision, directive } = await deps.service.continueRun(session.id, { turnState });
    if (decision === 'advance' && directive) {
      try {
        await deps.sendDirective(conversationId, directive);
      } catch (sendErr) {
        // continueRun already flipped the next step to `now`. If the directive
        // that tells the agent to DO that step never lands, the run would sit
        // `now` forever with no further turn to retrigger this listener. Park it
        // so the UI surfaces a resumable "interrupted" state instead of a chat
        // that silently stops advancing.
        console.warn('[parentTurnDriver] advance send failed, parking run:', sendErr);
        await deps.service.setRunMode(session.id, 'awaiting_input');
      }
    }
  } catch (err) {
    console.warn('[parentTurnDriver] failed to drive parent workflow turn:', err);
  }
}
