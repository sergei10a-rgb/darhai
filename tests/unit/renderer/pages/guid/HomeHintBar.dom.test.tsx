/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { HomeHintBar } from '@renderer/pages/guid/components/HomeHintBar';
import { formatShortcut } from '@renderer/utils/ui/shortcutLabel';

describe('HomeHintBar', () => {
  // Labels are platform-native now (⌘K on macOS, Ctrl+K elsewhere) - a
  // Windows user shown ⌘ pressed the ⊞ Windows key and thought the shortcut
  // was broken. Asserting through the same helper keeps this test meaningful
  // on every runner instead of pinning one platform's glyphs.
  it('renders 3 kbd hints when chatStartedCount < 5', () => {
    render(<HomeHintBar chatStartedCount={2} />);
    expect(screen.getByText(formatShortcut(['mod', 'K']))).toBeInTheDocument();
    expect(screen.getByText(formatShortcut(['tab']))).toBeInTheDocument();
    expect(screen.getByText(formatShortcut(['mod', 'N']))).toBeInTheDocument();
  });

  it('never shows a macOS glyph on a non-Mac runner', () => {
    render(<HomeHintBar chatStartedCount={2} />);
    const bar = screen.getByTestId('home-hint-bar');
    if (!/Mac/i.test(navigator.userAgent)) {
      expect(bar.textContent ?? '').not.toMatch(/[⌘⌥⇧⌃]/);
    }
  });

  it('renders nothing when chatStartedCount >= 5', () => {
    const { container } = render(<HomeHintBar chatStartedCount={5} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for arbitrary counts >= 5', () => {
    const { container } = render(<HomeHintBar chatStartedCount={42} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders for chatStartedCount = 0 (brand new user)', () => {
    render(<HomeHintBar chatStartedCount={0} />);
    expect(screen.getByTestId('home-hint-bar')).toBeInTheDocument();
  });
});
