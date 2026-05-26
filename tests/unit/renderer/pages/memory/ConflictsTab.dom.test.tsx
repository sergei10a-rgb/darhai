/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * Wave 5 -- DOM tests for `ConflictsTab`.
 *
 * Covers:
 *   - Empty conflicts state renders the empty UI.
 *   - A conflict cluster renders its `fact` and its variants.
 *   - Clicking "Keep this" invokes `conflict.resolve` with the cluster id and
 *     winner-variant id.
 *   - On a successful resolve the list refetches and the resolved cluster
 *     drops out.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

const { brainInvokeMock, messageSuccessSpy, messageErrorSpy } = vi.hoisted(() => ({
  brainInvokeMock: vi.fn<
    (args: { verb: string; args?: Record<string, unknown> }) => Promise<
      { ok: true; data?: unknown } | { ok: false; error?: string; errorReason?: string }
    >
  >(),
  messageSuccessSpy: vi.fn(),
  messageErrorSpy: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    ijfw: {
      brainInvoke: { invoke: brainInvokeMock },
    },
  },
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>(
    '@arco-design/web-react'
  );
  return {
    ...actual,
    Message: {
      ...actual.Message,
      success: messageSuccessSpy,
      error: messageErrorSpy,
    },
  };
});

import ConflictsTab from '@renderer/pages/memory/tabs/ConflictsTab';

type Variant = { id: string; preview: string; createdAt: number; source?: string };
type Conflict = { id: string; fact: string; variants: Variant[] };

const makeConflicts = (conflicts: Conflict[]) => ({ ok: true as const, data: { conflicts } });

beforeEach(() => {
  brainInvokeMock.mockReset();
  messageSuccessSpy.mockReset();
  messageErrorSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ConflictsTab', () => {
  it('renders the empty state when memory_facts returns no conflicts', async () => {
    brainInvokeMock.mockResolvedValueOnce(makeConflicts([]));
    render(<ConflictsTab />);
    await waitFor(() => {
      expect(screen.getByTestId('memory-conflicts-empty')).toBeTruthy();
    });
    expect(screen.queryByTestId('memory-conflicts-list')).toBeNull();
  });

  it('renders one cluster per conflict with the fact title and variant previews', async () => {
    brainInvokeMock.mockResolvedValueOnce(
      makeConflicts([
        {
          id: 'c1',
          fact: 'Database stack',
          variants: [
            { id: 'v1', preview: 'we use postgres', createdAt: 1 },
            { id: 'v2', preview: 'we migrated to dynamodb', createdAt: 2 },
          ],
        },
      ])
    );

    render(<ConflictsTab />);
    await waitFor(() => {
      expect(screen.getByTestId('memory-conflicts-cluster-c1')).toBeTruthy();
    });

    const cluster = screen.getByTestId('memory-conflicts-cluster-c1');
    expect(cluster.textContent).toContain('Database stack');
    expect(screen.getByTestId('memory-conflicts-variant-v1').textContent).toContain(
      'we use postgres'
    );
    expect(screen.getByTestId('memory-conflicts-variant-v2').textContent).toContain(
      'we migrated to dynamodb'
    );
  });

  it('invokes conflict.resolve with the conflictId and winnerVariantId when Keep this is clicked', async () => {
    brainInvokeMock.mockResolvedValueOnce(
      makeConflicts([
        {
          id: 'c1',
          fact: 'Database stack',
          variants: [
            { id: 'v1', preview: 'we use postgres', createdAt: 1 },
            { id: 'v2', preview: 'we migrated to dynamodb', createdAt: 2 },
          ],
        },
      ])
    );
    // Resolve call + the refetch that follows on success.
    brainInvokeMock.mockResolvedValueOnce({ ok: true, data: undefined });
    brainInvokeMock.mockResolvedValueOnce(makeConflicts([]));

    render(<ConflictsTab />);
    await waitFor(() => {
      expect(screen.getByTestId('memory-conflicts-keep-v2')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-conflicts-keep-v2'));
    });

    await waitFor(() => {
      expect(brainInvokeMock).toHaveBeenCalledWith({
        verb: 'conflict.resolve',
        args: { conflictId: 'c1', winnerVariantId: 'v2' },
      });
    });
    expect(messageSuccessSpy).toHaveBeenCalledTimes(1);
  });

  it('refetches the conflicts list after a successful resolve so the cluster drops out', async () => {
    brainInvokeMock.mockResolvedValueOnce(
      makeConflicts([
        {
          id: 'c1',
          fact: 'Database stack',
          variants: [
            { id: 'v1', preview: 'we use postgres', createdAt: 1 },
            { id: 'v2', preview: 'we migrated to dynamodb', createdAt: 2 },
          ],
        },
      ])
    );
    brainInvokeMock.mockResolvedValueOnce({ ok: true, data: undefined });
    brainInvokeMock.mockResolvedValueOnce(makeConflicts([]));

    render(<ConflictsTab />);
    await waitFor(() => {
      expect(screen.getByTestId('memory-conflicts-cluster-c1')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('memory-conflicts-keep-v1'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('memory-conflicts-cluster-c1')).toBeNull();
    });
    expect(screen.getByTestId('memory-conflicts-empty')).toBeTruthy();

    // Three calls in total: initial fetch + resolve + post-resolve refetch.
    expect(brainInvokeMock).toHaveBeenCalledTimes(3);
    const verbs = brainInvokeMock.mock.calls.map((c) => c[0].verb);
    expect(verbs).toEqual(['memory_facts', 'conflict.resolve', 'memory_facts']);
  });
});
