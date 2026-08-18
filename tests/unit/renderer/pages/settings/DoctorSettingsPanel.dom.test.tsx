/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for DoctorSettingsPanel (Settings -> Diagnostics).
 *
 * Covers:
 *   - Title, run button and empty state render before any run.
 *   - Clicking Run invokes `ipcBridge.doctor.run` and renders the report:
 *     overall tag, per-check rows (status tag + translated title + detail),
 *     and the remediation line only on non-pass results.
 *   - A rejected run surfaces the error line instead of a report.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoctorReport } from '@process/doctor/types';

const { runInvoke } = vi.hoisted(() => ({
  runInvoke: vi.fn<() => Promise<DoctorReport>>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).some((k) => k !== 'defaultValue') ? `${key}|${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    doctor: {
      run: { invoke: runInvoke },
    },
  },
}));

vi.mock('@renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid='spw-stub'>{children}</div>,
}));

import DoctorSettingsPanel from '@renderer/pages/settings/DoctorSettingsPanel';

const REPORT: DoctorReport = {
  ranAt: '2026-08-17T12:00:00.000Z',
  overall: 'fail',
  counts: { pass: 1, warn: 0, fail: 1 },
  results: [
    {
      id: 'runtime.bun',
      titleKey: 'settings.doctor.checks.bun.title',
      category: 'runtime',
      status: 'pass',
      detail: 'Bundled bun found: C:/bun.exe',
      durationMs: 3,
    },
    {
      id: 'system.diskSpace',
      titleKey: 'settings.doctor.checks.disk.title',
      category: 'system',
      status: 'fail',
      detail: 'Critically low disk space: 0.4 GB free.',
      remediation: 'Free up disk space now.',
      durationMs: 5,
    },
  ],
};

beforeEach(() => {
  runInvoke.mockReset();
  runInvoke.mockResolvedValue(REPORT);
});

afterEach(() => {
  cleanup();
});

const flushAsync = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('DoctorSettingsPanel', () => {
  it('renders the title, run button and empty state before any run', () => {
    render(<DoctorSettingsPanel />);
    expect(screen.getByText('settings.doctor.title')).toBeTruthy();
    expect(screen.getByTestId('doctor-run-button')).toBeTruthy();
    expect(screen.getByText('settings.doctor.empty')).toBeTruthy();
    expect(runInvoke).not.toHaveBeenCalled();
  });

  it('runs the battery on click and renders the grouped report', async () => {
    render(<DoctorSettingsPanel />);

    fireEvent.click(screen.getByTestId('doctor-run-button'));
    await flushAsync();

    expect(runInvoke).toHaveBeenCalledTimes(1);
    // Overall verdict + counts.
    expect(screen.getByTestId('doctor-overall')).toBeTruthy();
    expect(screen.getByText('settings.doctor.overall.fail')).toBeTruthy();
    // Both check rows, with translated titles and raw details.
    expect(screen.getByTestId('doctor-result-runtime.bun')).toBeTruthy();
    expect(screen.getByText('settings.doctor.checks.bun.title')).toBeTruthy();
    expect(screen.getByText('Bundled bun found: C:/bun.exe')).toBeTruthy();
    expect(screen.getByTestId('doctor-result-system.diskSpace')).toBeTruthy();
    // Remediation renders only for the failing check.
    expect(screen.getByTestId('doctor-remediation-system.diskSpace')).toBeTruthy();
    expect(screen.queryByTestId('doctor-remediation-runtime.bun')).toBeNull();
    // Category group headers for exactly the categories present.
    expect(screen.getByText('settings.doctor.category.runtime')).toBeTruthy();
    expect(screen.getByText('settings.doctor.category.system')).toBeTruthy();
    expect(screen.queryByText('settings.doctor.category.services')).toBeNull();
  });

  it('surfaces an error line when the run rejects', async () => {
    runInvoke.mockRejectedValueOnce(new Error('bridge down'));
    render(<DoctorSettingsPanel />);

    fireEvent.click(screen.getByTestId('doctor-run-button'));
    await flushAsync();

    expect(screen.getByTestId('doctor-error')).toBeTruthy();
    expect(screen.queryByTestId('doctor-overall')).toBeNull();
  });
});
