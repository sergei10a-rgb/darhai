/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * Wave 5 — DOM tests for DropTab.
 *
 * All file-safety logic lives in main process via `ijfwDropBridge`; the
 * renderer only calls IPC providers. These tests therefore mock the three
 * IPC providers (`dropList`, `dropIngest`, `dropQuarantine`) plus
 * `dialog.showOpen`, and assert the UI calls them with the right shapes
 * and surfaces success / error toasts.
 *
 * Cases:
 *   - Empty queue renders the empty state.
 *   - Non-empty queue renders one row per file with quarantine button.
 *   - Drag/drop triggers dropIngest for each dropped file path.
 *   - Quarantine button click invokes dropQuarantine with the row's name.
 *   - Error ingest result shows Message.error with the localized errorReason.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dropListMock, dropIngestMock, dropQuarantineMock, showOpenMock, messageErrorMock, messageSuccessMock } =
  vi.hoisted(() => ({
    dropListMock: vi.fn(),
    dropIngestMock: vi.fn(),
    dropQuarantineMock: vi.fn(),
    showOpenMock: vi.fn(),
    messageErrorMock: vi.fn(),
    messageSuccessMock: vi.fn(),
  }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; name?: string }) => {
      if (opts && typeof opts === 'object' && 'name' in opts) {
        return `${key}:${(opts as { name?: string }).name ?? ''}`;
      }
      return key;
    },
  }),
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>(
    '@arco-design/web-react'
  );
  return {
    ...actual,
    Message: {
      ...actual.Message,
      success: messageSuccessMock,
      error: messageErrorMock,
    },
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    ijfw: {
      dropList: { invoke: dropListMock },
      dropIngest: { invoke: dropIngestMock },
      dropQuarantine: { invoke: dropQuarantineMock },
    },
    dialog: {
      showOpen: { invoke: showOpenMock },
    },
  },
}));

import DropTab from '@renderer/pages/memory/tabs/DropTab';

beforeEach(() => {
  dropListMock.mockReset();
  dropIngestMock.mockReset();
  dropQuarantineMock.mockReset();
  showOpenMock.mockReset();
  messageErrorMock.mockReset();
  messageSuccessMock.mockReset();
  dropListMock.mockResolvedValue({ files: [] });
});

afterEach(() => {
  cleanup();
});

describe('DropTab', () => {
  it('renders the empty state when the queue is empty', async () => {
    await act(async () => {
      render(<DropTab />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('memory-drop-empty')).toBeTruthy();
    });
    expect(dropListMock).toHaveBeenCalledTimes(1);
  });

  it('renders one row per file when the queue is non-empty', async () => {
    dropListMock.mockResolvedValueOnce({
      files: [
        { name: 'a.md', size: 2048, mtimeMs: 1_700_000_000_000 },
        { name: 'b.json', size: 512, mtimeMs: 1_700_000_001_000 },
      ],
    });
    await act(async () => {
      render(<DropTab />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('memory-drop-list')).toBeTruthy();
    });
    expect(screen.getByTestId('memory-drop-row-a.md')).toBeTruthy();
    expect(screen.getByTestId('memory-drop-row-b.json')).toBeTruthy();
    expect(screen.getByTestId('memory-drop-quarantine-a.md')).toBeTruthy();
  });

  it('calls dropIngest with the dropped file path on drag/drop', async () => {
    dropIngestMock.mockResolvedValue({ ok: true, name: 'dropped.md' });
    await act(async () => {
      render(<DropTab />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('memory-drop-empty')).toBeTruthy();
    });

    const zone = screen.getByTestId('memory-drop-zone');
    const fakeFile = { name: 'dropped.md', path: '/abs/path/dropped.md' } as unknown as File;

    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: { files: [fakeFile] },
      });
    });

    await waitFor(() => {
      expect(dropIngestMock).toHaveBeenCalledWith({ path: '/abs/path/dropped.md' });
    });
    expect(messageSuccessMock).toHaveBeenCalled();
    // Refresh after ingest = second call to dropList.
    expect(dropListMock).toHaveBeenCalledTimes(2);
  });

  it('invokes dropQuarantine with the row name when the quarantine button is clicked', async () => {
    dropListMock.mockResolvedValueOnce({
      files: [{ name: 'killme.txt', size: 100, mtimeMs: 1_700_000_000_000 }],
    });
    dropQuarantineMock.mockResolvedValue({ ok: true });
    await act(async () => {
      render(<DropTab />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('memory-drop-quarantine-killme.txt')).toBeTruthy();
    });
    const btn = screen.getByTestId('memory-drop-quarantine-killme.txt');
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(dropQuarantineMock).toHaveBeenCalledWith({ name: 'killme.txt' });
    });
    expect(messageSuccessMock).toHaveBeenCalled();
  });

  it('shows a localized error toast when dropIngest returns ok:false with errorReason', async () => {
    dropIngestMock.mockResolvedValue({
      ok: false,
      error: 'too big',
      errorReason: 'validation_failed',
    });
    await act(async () => {
      render(<DropTab />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('memory-drop-empty')).toBeTruthy();
    });
    const zone = screen.getByTestId('memory-drop-zone');
    const fakeFile = { name: 'bad.md', path: '/abs/bad.md' } as unknown as File;
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [fakeFile] } });
    });
    await waitFor(() => {
      expect(messageErrorMock).toHaveBeenCalled();
    });
    // The localized key should reflect the errorReason from main.
    const calls = messageErrorMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s === 'memory.error.validation_failed')).toBe(true);
  });
});
