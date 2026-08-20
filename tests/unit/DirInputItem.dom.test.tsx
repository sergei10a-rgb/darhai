/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The default work directory still lives in the on-disk `wayland` folder -
 * renaming it would strand existing user data - so the System settings row
 * leads with a branded label and demotes the raw absolute path to a secondary
 * line. These tests pin that display contract: the path must stay visible,
 * selectable (copyable), and the directory picker must keep working.
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Form } from '@arco-design/web-react';

// Mock window.matchMedia for the Arco Design responsive observer
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const showOpen = vi.fn().mockResolvedValue(['C:\\picked\\dir']);

vi.mock('@/common', () => ({
  ipcBridge: { dialog: { showOpen: { invoke: (...a: unknown[]) => showOpen(...a) } } },
}));

// eslint-disable-next-line import/first
import DirInputItem from '@renderer/components/settings/SettingsModal/contents/SystemModalContent/DirInputItem';

const WORK_DIR = 'C:\\Users\\serge\\AppData\\Roaming\\Darhai\\wayland';

function setup(props: { displayName?: string } = {}) {
  render(
    <Form initialValues={{ workDir: WORK_DIR }}>
      <DirInputItem label='settings.workDir' field='workDir' {...props} />
    </Form>
  );
}

describe('DirInputItem', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leads with the branded label instead of the raw path when displayName is given', () => {
    setup({ displayName: 'settings.workDirDisplayName' });
    const label = screen.getByText('settings.workDirDisplayName');
    const path = screen.getByText(WORK_DIR);
    expect(label).toBeInTheDocument();
    expect(path).toBeInTheDocument();
    // The branded label must come first in document order.
    expect(label.compareDocumentPosition(path) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the absolute path selectable so it can still be copied', () => {
    setup({ displayName: 'settings.workDirDisplayName' });
    expect(screen.getByText(WORK_DIR).style.userSelect).toBe('text');
  });

  it('keeps the directory picker working in the relabelled row', () => {
    setup({ displayName: 'settings.workDirDisplayName' });
    fireEvent.click(screen.getByRole('button'));
    expect(showOpen).toHaveBeenCalledTimes(1);
    expect(showOpen).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: WORK_DIR }));
  });

  it('still shows the bare path when no displayName is given (cache dir row)', () => {
    setup();
    expect(screen.getByText(WORK_DIR)).toBeInTheDocument();
    expect(screen.queryByText('settings.workDirDisplayName')).not.toBeInTheDocument();
  });

  it('falls back to the not-configured copy when the field is empty', () => {
    render(
      <Form initialValues={{ workDir: '' }}>
        <DirInputItem label='settings.workDir' field='workDir' displayName='settings.workDirDisplayName' />
      </Form>
    );
    expect(screen.getByText('settings.dirNotConfigured')).toBeInTheDocument();
  });
});
