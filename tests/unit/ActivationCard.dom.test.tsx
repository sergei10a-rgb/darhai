/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback || key,
  }),
}));

import ActivationCard from '@renderer/components/activation/ActivationCard';

function setup(over: Partial<React.ComponentProps<typeof ActivationCard>> = {}) {
  const props = {
    onUseOwnKey: vi.fn(),
    onUseClaudeCode: vi.fn(),
    onPathSelected: vi.fn(),
    ...over,
  };
  render(<ActivationCard {...props} />);
  return props;
}

describe('ActivationCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders both activation paths', () => {
    setup();
    expect(screen.getByTestId('activation-path-own-key')).toBeInTheDocument();
    expect(screen.getByTestId('activation-path-claude-code')).toBeInTheDocument();
  });

  it('exposes an accessible region with a label', () => {
    setup();
    const region = screen.getByRole('region', { name: /conversation.activation.title/i });
    expect(region).toBeInTheDocument();
  });

  it('fires onUseOwnKey and onPathSelected("own-key") when the own-key path is clicked', () => {
    const props = setup();
    const row = screen.getByTestId('activation-path-own-key');
    fireEvent.click(within(row).getByRole('button'));
    expect(props.onUseOwnKey).toHaveBeenCalledTimes(1);
    expect(props.onPathSelected).toHaveBeenCalledWith('own-key');
  });

  it('fires onUseClaudeCode and onPathSelected("claude-code") when the Claude Code path is clicked', () => {
    const props = setup();
    const row = screen.getByTestId('activation-path-claude-code');
    fireEvent.click(within(row).getByRole('button'));
    expect(props.onUseClaudeCode).toHaveBeenCalledTimes(1);
    expect(props.onPathSelected).toHaveBeenCalledWith('claude-code');
  });

  it('does not require onPathSelected (optional telemetry hook)', () => {
    const onUseOwnKey = vi.fn();
    render(<ActivationCard onUseOwnKey={onUseOwnKey} onUseClaudeCode={vi.fn()} />);
    const row = screen.getByTestId('activation-path-own-key');
    expect(() => fireEvent.click(within(row).getByRole('button'))).not.toThrow();
    expect(onUseOwnKey).toHaveBeenCalledTimes(1);
  });
});
