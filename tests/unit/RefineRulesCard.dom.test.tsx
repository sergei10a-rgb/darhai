/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback || key }),
}));

vi.mock('@/common/adapter/ipcBridge', () => {
  const gg = globalThis as Record<string, unknown>;
  const mk = (name: string): ReturnType<typeof vi.fn> => (gg[name] ??= vi.fn()) as ReturnType<typeof vi.fn>;
  return {
    refine: {
      listRules: { invoke: mk('__refCardList') },
      applyRules: { invoke: mk('__refCardApply') },
      rollback: { invoke: mk('__refCardRollback') },
    },
  };
});

const g = globalThis as Record<string, unknown>;
const listMock = g.__refCardList as ReturnType<typeof vi.fn>;
const applyMock = g.__refCardApply as ReturnType<typeof vi.fn>;
const rollbackMock = g.__refCardRollback as ReturnType<typeof vi.fn>;

import RefineRulesCard from '@renderer/pages/settings/components/RefineRulesCard';

beforeEach(() => {
  listMock.mockReset().mockResolvedValue({ rules: [] });
  applyMock
    .mockReset()
    .mockResolvedValue({
      id: 'refine_1',
      scope: 'session',
      applied: [{ action: 'add', scope: 'session', id: 'r1', applied: true }],
    });
  rollbackMock.mockReset().mockResolvedValue({ ok: true, result: null });
});

afterEach(() => vi.clearAllMocks());

describe('RefineRulesCard', () => {
  it('applies a new rule as a session-scoped add pass', async () => {
    render(<RefineRulesCard />);
    await screen.findByTestId('refine-rules-card');

    const input = screen.getByPlaceholderText('settings.refineRules.addPlaceholder');
    fireEvent.change(input, { target: { value: 'always measure' } });
    fireEvent.click(screen.getByTestId('refine-rule-add'));

    await waitFor(() =>
      expect(applyMock).toHaveBeenCalledWith({
        scope: 'session',
        edits: [{ action: 'add', scope: 'session', text: 'always measure' }],
      })
    );
  });

  it('enables Rollback only after an applied pass', async () => {
    render(<RefineRulesCard />);
    await screen.findByTestId('refine-rules-card');

    // Nothing applied yet -> rollback disabled.
    expect(screen.getByTestId('refine-rollback')).toBeDisabled();

    const input = screen.getByPlaceholderText('settings.refineRules.addPlaceholder');
    fireEvent.change(input, { target: { value: 'a durable rule' } });
    fireEvent.click(screen.getByTestId('refine-rule-add'));

    // After a successful apply pass, rollback becomes available.
    await waitFor(() => expect(screen.getByTestId('refine-rollback')).not.toBeDisabled());

    fireEvent.click(screen.getByTestId('refine-rollback'));
    await waitFor(() => expect(rollbackMock).toHaveBeenCalledTimes(1));
  });
});
