/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The backup card that swallowed its own outcome.
 *
 * `handleExport` and `handleImport` both ended in `.finally(() => setBusy(false))`
 * with no `.then` and no `.catch`. The spinner stopped and nothing else
 * happened - so a successful restore looked identical to a failed one, and a
 * rejected promise (the shape `backupImport` uses to refuse a truncated or
 * non-SQLite archive) reached the user as complete silence.
 *
 * That silence is the dangerous half. The restore path deliberately throws
 * rather than overwrite a real database with a bad archive; if the refusal is
 * invisible, the user concludes the restore worked.
 *
 * Cancelling the OS file dialog is NOT a failure, and the handlers must stay
 * quiet for it - otherwise every dismissed dialog raises an error toast.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback || key }),
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  const g = globalThis as Record<string, unknown>;
  return {
    ...actual,
    Message: {
      success: (g.__msgSuccess ??= vi.fn()),
      error: (g.__msgError ??= vi.fn()),
      warning: (g.__msgWarning ??= vi.fn()),
      info: (g.__msgInfo ??= vi.fn()),
    },
    Modal: {
      ...actual.Modal,
      // Record the confirm call so a test can assert the gate exists, and let
      // each test decide whether the user accepts by invoking onOk itself.
      confirm: (g.__modalConfirm ??= vi.fn()),
    },
  };
});

vi.mock('@/common/adapter/ipcBridge', () => {
  const g = globalThis as Record<string, unknown>;
  return {
    storage: {
      exportAll: { invoke: (g.__exportAll ??= vi.fn()) },
      importBackup: { invoke: (g.__importBackup ??= vi.fn()) },
    },
  };
});

const g = globalThis as Record<string, unknown>;
const exportAll = g.__exportAll as ReturnType<typeof vi.fn>;
const importBackup = g.__importBackup as ReturnType<typeof vi.fn>;
const msgSuccess = g.__msgSuccess as ReturnType<typeof vi.fn>;
const msgError = g.__msgError as ReturnType<typeof vi.fn>;
const modalConfirm = g.__modalConfirm as ReturnType<typeof vi.fn>;

/**
 * Click Restore and accept the confirmation, the way a user would.
 *
 * Restore relaunches the app on success, so it is gated behind a confirm
 * dialog; the tests below are about what happens AFTER consent.
 */
function restoreAndAccept(): void {
  fireEvent.click(restoreButton());
  const call = modalConfirm.mock.calls[0]?.[0] as { onOk?: () => void } | undefined;
  if (!call?.onOk) throw new Error('Restore did not open a confirmation dialog');
  call.onOk();
}

import BackupCard from '@renderer/pages/settings/StorageSettings/BackupCard';

beforeEach(() => {
  exportAll.mockReset();
  importBackup.mockReset();
  msgSuccess.mockReset();
  msgError.mockReset();
  modalConfirm.mockReset();
});

afterEach(() => vi.clearAllMocks());

/**
 * The two buttons. The component calls `t()` without a fallback string, so
 * under the stubbed translator the rendered label is the key itself.
 */
const exportButton = (): HTMLElement => screen.getByRole('button', { name: /storagePage\.exportAll/ });
const restoreButton = (): HTMLElement => screen.getByRole('button', { name: /storagePage\.restore/ });

describe('BackupCard export', () => {
  it('confirms a completed export', async () => {
    exportAll.mockResolvedValue({ ok: true, path: 'C:\\tmp\\darhai-backup-2026-08-20.zip' });
    render(<BackupCard />);
    fireEvent.click(exportButton());
    await waitFor(() => expect(msgSuccess).toHaveBeenCalledTimes(1));
    expect(msgError).not.toHaveBeenCalled();
  });

  it('stays quiet when the user dismisses the save dialog', async () => {
    exportAll.mockResolvedValue({ ok: false, canceled: true });
    render(<BackupCard />);
    fireEvent.click(exportButton());
    // Give any toast a chance to fire before asserting its absence.
    await waitFor(() => expect(exportAll).toHaveBeenCalled());
    expect(msgSuccess).not.toHaveBeenCalled();
    expect(msgError).not.toHaveBeenCalled();
  });

  it('surfaces a rejected export instead of swallowing it', async () => {
    exportAll.mockRejectedValue(new Error('disk full'));
    render(<BackupCard />);
    fireEvent.click(exportButton());
    await waitFor(() => expect(msgError).toHaveBeenCalledTimes(1));
    // The reason has to reach the user, not just the log.
    expect(String(msgError.mock.calls[0]?.[0] ?? '')).toContain('disk full');
  });

  it('reports a failure the main process signalled without throwing', async () => {
    // `{ok:false}` with no `canceled` flag is a real failure, not a dismissal.
    exportAll.mockResolvedValue({ ok: false });
    render(<BackupCard />);
    fireEvent.click(exportButton());
    await waitFor(() => expect(msgError).toHaveBeenCalledTimes(1));
    expect(msgSuccess).not.toHaveBeenCalled();
  });
});

describe('BackupCard restore', () => {
  it('asks before doing anything, because a restore relaunches the app', () => {
    importBackup.mockResolvedValue({ ok: true });
    render(<BackupCard />);
    fireEvent.click(restoreButton());
    // The click alone must not reach the main process: a successful restore
    // relaunches, which would interrupt whatever turn is in flight.
    expect(modalConfirm).toHaveBeenCalledTimes(1);
    expect(importBackup).not.toHaveBeenCalled();
  });

  it('does nothing when the confirmation is declined', () => {
    importBackup.mockResolvedValue({ ok: true });
    render(<BackupCard />);
    fireEvent.click(restoreButton());
    // Declining = never invoking onOk. Nothing else may run.
    expect(importBackup).not.toHaveBeenCalled();
    expect(msgSuccess).not.toHaveBeenCalled();
    expect(msgError).not.toHaveBeenCalled();
  });

  it('confirms a completed restore', async () => {
    importBackup.mockResolvedValue({ ok: true });
    render(<BackupCard />);
    restoreAndAccept();
    await waitFor(() => expect(msgSuccess).toHaveBeenCalledTimes(1));
    expect(msgError).not.toHaveBeenCalled();
  });

  it('stays quiet when the user dismisses the open dialog', async () => {
    importBackup.mockResolvedValue({ ok: false, canceled: true });
    render(<BackupCard />);
    restoreAndAccept();
    await waitFor(() => expect(importBackup).toHaveBeenCalled());
    expect(msgSuccess).not.toHaveBeenCalled();
    expect(msgError).not.toHaveBeenCalled();
  });

  it('shows why a refused archive was refused', async () => {
    // This is the case that matters most: backupImport throws rather than
    // overwrite a real database with a bad archive. If the refusal is silent,
    // the user believes the restore succeeded.
    importBackup.mockRejectedValue(
      new Error('[backupImport] Refusing to restore: the archive’s database entry is not a SQLite file')
    );
    render(<BackupCard />);
    restoreAndAccept();
    await waitFor(() => expect(msgError).toHaveBeenCalledTimes(1));
    expect(String(msgError.mock.calls[0]?.[0] ?? '')).toContain('not a SQLite file');
    expect(msgSuccess).not.toHaveBeenCalled();
  });

  it('clears the busy state after a failure so the button can be used again', async () => {
    importBackup.mockRejectedValue(new Error('nope'));
    render(<BackupCard />);
    restoreAndAccept();
    await waitFor(() => expect(msgError).toHaveBeenCalled());
    // A button left spinning after an error strands the user on a dead card.
    await waitFor(() => expect(restoreButton()).not.toBeDisabled());
  });
});
