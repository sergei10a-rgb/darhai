/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowSession } from '@/common/types/workflowTypes';

const findAllActiveMock = vi.fn();

vi.mock('@/common', () => ({
  ipcBridge: {
    workflow: {
      findAllActive: { invoke: (...a: unknown[]) => findAllActiveMock(...a) },
    },
  },
}));

import { InFlightWorkflowsStrip } from '@/renderer/pages/guid/components/workflow/InFlightWorkflowsStrip';

const NOW = 1_700_000_000_000;

const makeSession = (overrides: Partial<WorkflowSession> = {}): WorkflowSession => ({
  id: 'wf-1',
  workflow_name: 'shipping-checklist',
  workflow_title: 'Shipping Checklist',
  conversation_id: 'conv-1',
  current_step: 2,
  total_steps: 5,
  steps: [],
  skills: [],
  asks: [],
  status: 'active',
  palette: null,
  category: 'Business Operations',
  created_at: NOW - 2 * 60 * 60 * 1000, // 2 hours ago
  updated_at: NOW - 2 * 60 * 60 * 1000,
  completed_at: null,
  ...overrides,
});

const makeRow = (
  session: WorkflowSession,
  conversation_preview = 'short preview'
): { session: WorkflowSession; conversation_preview: string } => ({
  session,
  conversation_preview,
});

beforeEach(() => {
  findAllActiveMock.mockReset();
  // Pin Date.now() without freezing setTimeout — waitFor polls via real
  // timers and would otherwise hang if vi.useFakeTimers() were active.
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InFlightWorkflowsStrip', () => {
  it('renders nothing while the initial fetch is in flight', () => {
    // Hold the promise unresolved → component should not render anything.
    findAllActiveMock.mockReturnValue(new Promise(() => {}));

    const { container } = render(<InFlightWorkflowsStrip onResume={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when there are 0 in-flight sessions', async () => {
    findAllActiveMock.mockResolvedValue({ sessions: [] });

    const { container } = render(<InFlightWorkflowsStrip onResume={vi.fn()} />);

    await waitFor(() => expect(findAllActiveMock).toHaveBeenCalled());
    // Allow the effect's setState to flush.
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('invokes findAllActive with { limit: 3 } on mount', async () => {
    findAllActiveMock.mockResolvedValue({ sessions: [] });

    render(<InFlightWorkflowsStrip onResume={vi.fn()} />);

    await waitFor(() => expect(findAllActiveMock).toHaveBeenCalledTimes(1));
    expect(findAllActiveMock).toHaveBeenCalledWith({ limit: 3 });
  });

  it('renders one card with title, step counter, relative age, and preview', async () => {
    const session = makeSession({
      workflow_title: 'Quarterly Review',
      current_step: 3,
      total_steps: 7,
      updated_at: NOW - 2 * 60 * 60 * 1000, // 2 hours ago
    });
    findAllActiveMock.mockResolvedValue({
      sessions: [makeRow(session, 'Drafting the Q3 board summary now')],
    });

    render(<InFlightWorkflowsStrip onResume={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Quarterly Review')).toBeTruthy());
    expect(screen.getByText(/In-flight workflows/i)).toBeTruthy();
    expect(screen.getByText(/Step 3 of 7/)).toBeTruthy();
    expect(screen.getByText(/2 hours ago/)).toBeTruthy();
    expect(screen.getByText(/Drafting the Q3 board summary now/)).toBeTruthy();
    expect(screen.getAllByTestId('inflight-workflow-card')).toHaveLength(1);
  });

  it('renders up to 3 cards when 3 sessions are returned', async () => {
    findAllActiveMock.mockResolvedValue({
      sessions: [
        makeRow(makeSession({ id: 'a', workflow_title: 'Alpha' }), 'preview a'),
        makeRow(makeSession({ id: 'b', workflow_title: 'Beta' }), 'preview b'),
        makeRow(makeSession({ id: 'c', workflow_title: 'Gamma' }), 'preview c'),
      ],
    });

    render(<InFlightWorkflowsStrip onResume={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('Gamma')).toBeTruthy();
    expect(screen.getAllByTestId('inflight-workflow-card')).toHaveLength(3);
  });

  it('fires onResume with the clicked session', async () => {
    const onResume = vi.fn();
    const session = makeSession({ id: 'click-me', workflow_title: 'Click Me' });
    findAllActiveMock.mockResolvedValue({
      sessions: [makeRow(session, 'preview')],
    });

    render(<InFlightWorkflowsStrip onResume={onResume} />);

    await waitFor(() => expect(screen.getByText('Click Me')).toBeTruthy());
    fireEvent.click(screen.getByTestId('inflight-workflow-card'));

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith(session);
  });

  it('truncates conversation_preview longer than 80 chars with an ellipsis', async () => {
    const longPreview = 'a'.repeat(120);
    const session = makeSession({ workflow_title: 'Long Preview' });
    findAllActiveMock.mockResolvedValue({
      sessions: [makeRow(session, longPreview)],
    });

    render(<InFlightWorkflowsStrip onResume={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Long Preview')).toBeTruthy());
    const previewEl = screen.getByTestId('inflight-workflow-preview');
    const text = previewEl.textContent ?? '';
    // 80-char visible body + the ellipsis character.
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(81);
    expect(text.startsWith('a'.repeat(80))).toBe(true);
  });

  it('renders the bare preview unchanged when it is <= 80 chars', async () => {
    const shortPreview = 'just a short snippet';
    const session = makeSession({ workflow_title: 'Short Preview' });
    findAllActiveMock.mockResolvedValue({
      sessions: [makeRow(session, shortPreview)],
    });

    render(<InFlightWorkflowsStrip onResume={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Short Preview')).toBeTruthy());
    const previewEl = screen.getByTestId('inflight-workflow-preview');
    expect(previewEl.textContent).toBe(shortPreview);
  });

  it('renders relative age "yesterday" for ~1 day old sessions', async () => {
    const session = makeSession({
      workflow_title: 'Yesterday Job',
      updated_at: NOW - 28 * 60 * 60 * 1000, // 28 hours
    });
    findAllActiveMock.mockResolvedValue({
      sessions: [makeRow(session, 'p')],
    });

    render(<InFlightWorkflowsStrip onResume={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Yesterday Job')).toBeTruthy());
    // Match the meta-line span exclusively (the aria-label also contains the
    // workflow title, which would otherwise also satisfy /yesterday/i).
    expect(screen.getByText(/^yesterday$/i)).toBeTruthy();
  });
});
