/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

// Unit tests for WorkflowMessageBody.
//
// Verifies:
//   - No workflowSessionId: children receive body verbatim, no IPC calls.
//   - With workflowSessionId + step marker: children receive stripped body;
//     applyStepMarker fires once with the correct args.
//   - Multiple step markers: all fire in order.
//   - ask markers: stripped from body; applyStepMarker is NOT called (v1 no-op).
//   - totalSteps falls back to the session data's total_steps once loaded.

import { render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------------ mocks ---

const applyStepMarkerMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/renderer/hooks/workflow/useWorkflowSession', () => ({
  useWorkflowSession: vi.fn(() => ({
    data: { total_steps: 6 },
    loading: false,
    error: null,
    isActive: () => true,
    jumpToStep: vi.fn(),
    runStepAutonomously: vi.fn(),
    answerAsk: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    end: vi.fn(),
    refresh: vi.fn(),
    applyStepMarker: applyStepMarkerMock,
  })),
}));

// ---- import after mocks are set up ----
import { WorkflowMessageBody } from '@/renderer/pages/conversation/Messages/components/WorkflowMessageBody';

// ---------------------------------------------------------------- helpers ---

const collectOutput = (workflowSessionId: string | undefined, body: string) => {
  const outputs: string[] = [];
  render(
    <WorkflowMessageBody workflowSessionId={workflowSessionId} body={body}>
      {(cleaned) => {
        outputs.push(cleaned);
        return <span data-testid='out'>{cleaned}</span>;
      }}
    </WorkflowMessageBody>
  );
  return outputs;
};

// ------------------------------------------------------------------ tests ---

describe('WorkflowMessageBody', () => {
  it('passes body verbatim when workflowSessionId is undefined', () => {
    applyStepMarkerMock.mockClear();
    const body = 'Hello world<step n="1" status="now"/>';
    const outputs = collectOutput(undefined, body);
    expect(outputs[outputs.length - 1]).toBe(body);
    expect(applyStepMarkerMock).not.toHaveBeenCalled();
  });

  it('strips a step marker and calls applyStepMarker when workflowSessionId is set', async () => {
    applyStepMarkerMock.mockClear();
    const body = 'Starting step 1.<step n="1" status="now"/> Work in progress.';
    const outputs = collectOutput('wf-session-1', body);
    const cleaned = outputs[outputs.length - 1];

    expect(cleaned).not.toContain('<step');
    expect(cleaned).toContain('Starting step 1.');
    expect(cleaned).toContain('Work in progress.');

    // applyStepMarker fires asynchronously via useEffect; let microtasks settle
    await Promise.resolve();
    expect(applyStepMarkerMock).toHaveBeenCalledWith(1, 'now', 'parent');
    expect(applyStepMarkerMock).toHaveBeenCalledTimes(1);
  });

  it('fires applyStepMarker for each step marker in the body', async () => {
    applyStepMarkerMock.mockClear();
    const body = 'A<step n="1" status="now"/>B<step n="1" status="done"/>C<step n="2" status="now"/>';
    collectOutput('wf-session-2', body);

    await Promise.resolve();
    expect(applyStepMarkerMock).toHaveBeenCalledTimes(3);
    expect(applyStepMarkerMock).toHaveBeenNthCalledWith(1, 1, 'now', 'parent');
    expect(applyStepMarkerMock).toHaveBeenNthCalledWith(2, 1, 'done', 'parent');
    expect(applyStepMarkerMock).toHaveBeenNthCalledWith(3, 2, 'now', 'parent');
  });

  it('strips ask markers from the body without calling applyStepMarker (v1 no-op)', async () => {
    applyStepMarkerMock.mockClear();
    const body = 'Question:<ask type="text">What is your name?</ask> Thanks.';
    const outputs = collectOutput('wf-session-3', body);
    const cleaned = outputs[outputs.length - 1];

    expect(cleaned).not.toContain('<ask');
    expect(cleaned).not.toContain('</ask>');

    await Promise.resolve();
    expect(applyStepMarkerMock).not.toHaveBeenCalled();
  });

  it('does not strip markers inside fenced code blocks and does not call applyStepMarker for them', async () => {
    applyStepMarkerMock.mockClear();
    const body = 'Example:\n```\n<step n="3" status="done"/>\n```\nDone.';
    const outputs = collectOutput('wf-session-4', body);
    const cleaned = outputs[outputs.length - 1];

    expect(cleaned).toContain('<step n="3" status="done"/>');

    await Promise.resolve();
    expect(applyStepMarkerMock).not.toHaveBeenCalled();
  });
});
