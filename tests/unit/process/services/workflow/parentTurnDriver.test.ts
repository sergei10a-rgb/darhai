/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the PARENT workflow driver hand (Phase 2a). The brain
 * (`continueRun`) is tested in WorkflowSessionService.test.ts; here we verify
 * the listener's routing + send decision:
 *  - a child autonomous-dispatch turn is NOT treated as a parent run.
 *  - a non-terminal turn state does nothing.
 *  - a parent terminal turn maps to its session and calls `continueRun`.
 *  - decision `advance` with a directive sends; `await_input`/`complete`/`halt`
 *    do not send.
 */

import { describe, expect, it, vi } from 'vitest';
import { handleParentWorkflowTurn } from '@process/services/workflow/parentTurnDriver';
import type { WorkflowSession } from '@/common/types/workflowTypes';
import type { IConversationTurnCompletedEvent } from '@/common/adapter/ipcBridge';

function turn(over: Partial<IConversationTurnCompletedEvent>): IConversationTurnCompletedEvent {
  return {
    sessionId: 'conv-1',
    status: 'finished',
    state: 'ai_waiting_input',
    detail: '',
    canSendMessage: true,
    runtime: { hasTask: false, isProcessing: false, pendingConfirmations: 0 },
    workspace: '',
    model: { platform: '', name: '', useModel: '' },
    lastMessage: { content: '', createdAt: 0 },
    ...over,
  };
}

function session(over: Partial<WorkflowSession> = {}): WorkflowSession {
  return {
    id: 'wf-1',
    workflow_name: 'demo',
    workflow_title: 'Demo',
    conversation_id: 'conv-1',
    current_step: 1,
    total_steps: 2,
    steps: [],
    skills: [],
    asks: [],
    status: 'active',
    palette: null,
    category: null,
    created_at: 0,
    updated_at: 0,
    completed_at: null,
    begin_sent_at: 1,
    run_mode: 'running',
    interactivity: 'auto',
    ...over,
  };
}

type Deps = Parameters<typeof handleParentWorkflowTurn>[1];

function makeDeps(over: Partial<{ findSession: WorkflowSession | null; isChild: boolean; decision: ReturnType<NonNullable<Deps['service']['continueRun']>> extends Promise<infer R> ? R : never }> = {}) {
  const continueRun = vi.fn(async () => ({
    decision: 'advance' as const,
    directive: 'Proceed to step 1: Audit',
    session: session(),
  }));
  const sendDirective = vi.fn(async () => undefined);
  const setRunMode = vi.fn(async () => session({ run_mode: 'awaiting_input' }));
  const deps: Deps = {
    service: {
      findByConversationId: vi.fn(() => over.findSession ?? null),
      continueRun,
      setRunMode,
    },
    isAutonomousChild: vi.fn(async () => over.isChild ?? false),
    sendDirective,
  };
  return { deps, continueRun, sendDirective, setRunMode };
}

describe('handleParentWorkflowTurn', () => {
  it('does nothing for a non-terminal turn state', async () => {
    const { deps, continueRun } = makeDeps({ findSession: session() });
    await handleParentWorkflowTurn(turn({ state: 'ai_generating' }), deps);
    expect(continueRun).not.toHaveBeenCalled();
  });

  it('does nothing when the conversation is an autonomous child', async () => {
    const { deps, continueRun } = makeDeps({ findSession: session(), isChild: true });
    await handleParentWorkflowTurn(turn({ state: 'ai_waiting_input' }), deps);
    expect(continueRun).not.toHaveBeenCalled();
    expect(deps.service.findByConversationId).not.toHaveBeenCalled();
  });

  it('does nothing when the conversation maps to no workflow session', async () => {
    const { deps, continueRun } = makeDeps({ findSession: null });
    await handleParentWorkflowTurn(turn({ state: 'ai_waiting_input' }), deps);
    expect(continueRun).not.toHaveBeenCalled();
  });

  it('advances: maps the parent conversation to its session, calls continueRun, sends the directive', async () => {
    const { deps, continueRun, sendDirective } = makeDeps({ findSession: session() });
    await handleParentWorkflowTurn(turn({ sessionId: 'conv-1', state: 'ai_waiting_input' }), deps);
    expect(deps.service.findByConversationId).toHaveBeenCalledWith('conv-1');
    // The completed turn's terminal state is threaded into the brain so the
    // driver-owned completion block (Stage 1) can mark the active step terminal.
    expect(continueRun).toHaveBeenCalledWith('wf-1', { turnState: 'ai_waiting_input' });
    expect(sendDirective).toHaveBeenCalledWith('conv-1', 'Proceed to step 1: Audit');
  });

  it('threads the error turn state into continueRun (driver parks on a failed turn)', async () => {
    const { deps, continueRun } = makeDeps({ findSession: session() });
    deps.service.continueRun = continueRun;
    await handleParentWorkflowTurn(turn({ sessionId: 'conv-1', state: 'error' }), deps);
    expect(continueRun).toHaveBeenCalledWith('wf-1', { turnState: 'error' });
  });

  it('does not send when the decision is await_input (step mode halt)', async () => {
    const { deps, sendDirective } = makeDeps({ findSession: session() });
    deps.service.continueRun = vi.fn(async () => ({
      decision: 'await_input' as const,
      directive: null,
      session: session({ run_mode: 'awaiting_input' }),
    }));
    await handleParentWorkflowTurn(turn({ state: 'ai_waiting_input' }), deps);
    expect(sendDirective).not.toHaveBeenCalled();
  });

  it('does not send when the decision is complete', async () => {
    const { deps, sendDirective } = makeDeps({ findSession: session() });
    deps.service.continueRun = vi.fn(async () => ({
      decision: 'complete' as const,
      directive: null,
      session: session({ run_mode: 'done', status: 'complete' }),
    }));
    await handleParentWorkflowTurn(turn({ state: 'ai_waiting_input' }), deps);
    expect(sendDirective).not.toHaveBeenCalled();
  });

  it('does not send when advance yields no directive (defensive)', async () => {
    const { deps, sendDirective } = makeDeps({ findSession: session() });
    deps.service.continueRun = vi.fn(async () => ({
      decision: 'advance' as const,
      directive: null,
      session: session(),
    }));
    await handleParentWorkflowTurn(turn({ state: 'ai_waiting_input' }), deps);
    expect(sendDirective).not.toHaveBeenCalled();
  });

  it('parks the run at awaiting_input when the advance send fails (never breaks the parent chat)', async () => {
    const { deps, setRunMode } = makeDeps({ findSession: session() });
    deps.sendDirective = vi.fn(async () => {
      throw new Error('send blew up');
    });
    await expect(handleParentWorkflowTurn(turn({ state: 'ai_waiting_input' }), deps)).resolves.toBeUndefined();
    // A failed send must leave the run resumable, not silently stuck `now`.
    expect(setRunMode).toHaveBeenCalledWith('wf-1', 'awaiting_input');
  });
});
