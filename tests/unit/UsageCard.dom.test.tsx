/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The storage line that read "--аас 1.6 MB ашигласан".
 *
 * The card renders `totalUsed`, whose template is "{{total}}-аас {{used}}
 * ашигласан" ("X of Y used") - but nothing ever computes a capacity, so the
 * component passed the literal `'-'` for `total`. Next to the Mongolian
 * ablative suffix that produced a double dash and a sentence that promises a
 * ratio it does not have.
 *
 * There is no capacity to show: `computeUsage` sums the app's own directories,
 * not the volume. So the honest line states the total consumed and stops.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Render the real Mongolian strings: this is a test ABOUT the copy, so a
// key-echoing stub would assert nothing.
import mnSettings from '@renderer/services/i18n/locales/mn-MN/settings.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      const path = key.replace(/^settings\./, '').split('.');
      let node: unknown = mnSettings as unknown;
      for (const part of path) node = (node as Record<string, unknown>)?.[part];
      if (typeof node !== 'string') return key;
      return node.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(vars?.[name] ?? `{{${name}}}`));
    },
  }),
}));

vi.mock('@renderer/hooks/settings/useStorageUsage', () => {
  const g = globalThis as Record<string, unknown>;
  return { useStorageUsage: (g.__useStorageUsage ??= vi.fn()) };
});

const g = globalThis as Record<string, unknown>;
const useStorageUsage = g.__useStorageUsage as ReturnType<typeof vi.fn>;

import UsageCard from '@renderer/pages/settings/StorageSettings/UsageCard';

const USAGE = {
  used: 1_677_722, // ~1.6 MB, the figure on the screenshot
  computedAt: 1_700_000_000_000,
  breakdown: [
    { label: 'conversations', bytes: 1_600_000, color: '#f60' },
    { label: 'cache', bytes: 38, color: '#fc0' },
    { label: 'logs', bytes: 36_100, color: '#333' },
  ],
};

beforeEach(() => {
  useStorageUsage.mockReset().mockReturnValue({ data: USAGE, loading: false, refresh: vi.fn() });
});

afterEach(() => vi.clearAllMocks());

describe('UsageCard total line', () => {
  it('never renders a placeholder capacity', async () => {
    const { container } = render(<UsageCard />);
    await waitFor(() => expect(screen.getByText(/1\.6 MB/)).toBeTruthy());
    const text = container.textContent ?? '';
    // The exact string a user saw. A lone dash standing in for a number is not
    // a smaller truth - it is a broken sentence.
    expect(text).not.toContain('--аас');
    expect(text).not.toMatch(/(^|\s)-\s*-?аас/);
    // Nor an unresolved interpolation, which is the other way this breaks.
    expect(text).not.toContain('{{total}}');
  });

  it('still states how much is used', async () => {
    render(<UsageCard />);
    await waitFor(() => expect(screen.getByText(/1\.6 MB/)).toBeTruthy());
  });

  it('shows the breakdown legend with real byte figures', async () => {
    const { container } = render(<UsageCard />);
    await waitFor(() => expect(container.textContent).toContain('38 B'));
    expect(container.textContent).toContain('35.3 KB');
  });
});
