/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * Renderer-side guard for the false-green defect.
 *
 * The backend now persists `state: 'unverified'` for a provider whose only
 * probe answers the same way without the credential. That is only worth
 * anything if the row the user actually looks at stops claiming a verified
 * green connection - the audit's blind spot was checking bridges directly and
 * never the rendered surface. These assertions pin the rendered row.
 */

import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { IModelRegistryProviderView } from '../../../src/common/adapter/ipcBridge';

// i18n echoes the key so an assertion can tell "rendered the unverified copy"
// apart from "rendered the connected copy".
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      let out = key;
      for (const [k, v] of Object.entries(opts)) {
        if (k === 'defaultValue') continue;
        out += `:${k}=${String(v)}`;
      }
      return out;
    },
  }),
}));

import ConnectedRow from '../../../src/renderer/pages/settings/ModelsSettings/components/ConnectedRow';

function view(over: Partial<IModelRegistryProviderView> = {}): IModelRegistryProviderView {
  return {
    providerId: 'ollama-cloud',
    connectedVia: 'api-key',
    state: 'connected',
    modelCount: 17,
    ...over,
  };
}

function renderRow(provider: IModelRegistryProviderView) {
  return render(<ConnectedRow provider={provider} onManage={() => {}} onFix={() => {}} />);
}

describe('ConnectedRow - unverified provider', () => {
  it('renders the unverified copy, never the connected copy', () => {
    renderRow(view({ state: 'unverified' }));

    expect(screen.getByText('settings.modelsPage.row.unverified')).toBeTruthy();
    expect(screen.queryByText('settings.modelsPage.row.connected')).toBeNull();
  });

  it('exposes the state on the row so it is inspectable and styleable', () => {
    const { container } = renderRow(view({ state: 'unverified' }));

    const row = container.querySelector('[data-provider="ollama-cloud"]');
    expect(row?.getAttribute('data-state')).toBe('unverified');
  });

  it('stays usable - the model count and Manage action are still shown', () => {
    renderRow(view({ state: 'unverified' }));

    expect(screen.getByText('settings.modelsPage.row.modelCount:count=17')).toBeTruthy();
    expect(screen.getByText('settings.modelsPage.row.manage')).toBeTruthy();
    // Not an error state: no "Action needed" and no Fix button.
    expect(screen.queryByText('settings.modelsPage.row.fix')).toBeNull();
  });

  it('still renders the connected copy for a verified provider', () => {
    renderRow(view({ state: 'connected' }));

    expect(screen.getByText('settings.modelsPage.row.connected')).toBeTruthy();
    expect(screen.queryByText('settings.modelsPage.row.unverified')).toBeNull();
  });
});
