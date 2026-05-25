/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the launchpad new-chat starter wiring (post-Phase 2
 * redesign). Mounting the full GuidPage in jsdom would drag in dozens of
 * unrelated subsystems (IPC bridges, SWR caches, agent registry, etc.).
 * Instead we compose the two pieces (QuickLaunchRow + RecentsStrip) with
 * the same handler shapes GuidPage.tsx wires up and assert end-to-end
 * behaviour: card click fills the input AND routes via
 * `selectPresetAssistant`; recents card resumes the conversation.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React, { useCallback, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; [k: string]: unknown }) => {
      const dv = options?.defaultValue ?? _key;
      return typeof dv === 'string'
        ? dv.replace(/{{\s*(\w+)\s*}}/g, (_m, name: string) => String(options?.[name] ?? ''))
        : _key;
    },
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({
    children,
    onClick,
    icon,
    type: _type,
    size: _size,
    shape: _shape,
    ...rest
  }: React.ComponentProps<'button'> & {
    type?: string;
    size?: string;
    shape?: string;
    icon?: React.ReactNode;
  }) => (
    <button type='button' onClick={onClick} {...rest}>
      {icon}
      {children}
    </button>
  ),
}));

vi.mock('swr', () => ({
  default: () => ({ data: [] as Record<string, unknown>[] }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    extensions: {
      getAssistants: { invoke: () => Promise.resolve([] as Record<string, unknown>[]) },
    },
  },
}));

vi.mock('@/renderer/pages/guid/hooks/useRecentConversations', () => ({
  useRecentConversations: () => ({ recents: [] }),
}));

import QuickLaunchRow from '@/renderer/pages/guid/components/newChatStarter/QuickLaunchRow';
import RecentsStrip from '@/renderer/pages/guid/components/newChatStarter/RecentsStrip';
import { ASSISTANT_PRESETS } from '@/common/config/presets/assistantPresets';
import {
  QUICK_LAUNCH_ANCHORS,
  type QuickLaunchAnchor,
} from '@/renderer/pages/guid/quickLaunchAnchors';

type SelectedAssistantKey = string | null;
type RecentSummary = { id: string };

/**
 * Mini-GuidPage harness that mirrors the wiring inside `GuidPage.tsx`. The
 * goal is to exercise the same callback shapes GuidPage uses, not to
 * recreate the full page.
 */
const TestHarness: React.FC<{
  onAssistantSelected: (key: SelectedAssistantKey) => void;
  onInputSet: (text: string) => void;
  onRecentResume: (conv: RecentSummary) => void;
  onViewAll?: () => void;
}> = ({ onAssistantSelected, onInputSet, onRecentResume, onViewAll }) => {
  const [input, setInput] = useState('');

  const handleAnchorClick = useCallback(
    (anchor: QuickLaunchAnchor) => {
      // Mirror GuidPage.handleQuickLaunchAnchor: built-in runtime ids carry the
      // `builtin-` prefix (see initStorage.ts), but ASSISTANT_PRESETS keys by
      // the bare id — strip the prefix for the preset lookup only, then pass
      // the prefixed runtime id through to selectPresetAssistant so the
      // customAgents registry lookup succeeds.
      const bareId = anchor.assistantId.startsWith('builtin-')
        ? anchor.assistantId.slice('builtin-'.length)
        : anchor.assistantId;
      const preset = ASSISTANT_PRESETS.find((p) => p.id === bareId);
      const backend = preset?.presetAgentType ?? 'gemini';
      onAssistantSelected(`custom:${anchor.assistantId}@${backend}`);
      onInputSet(anchor.prefill);
      setInput(anchor.prefill);
    },
    [onAssistantSelected, onInputSet]
  );

  return (
    <div>
      <input data-testid='harness-input' readOnly value={input} />
      <QuickLaunchRow onAnchorClick={handleAnchorClick} onViewAll={onViewAll ?? (() => {})} />
      <RecentsStrip
        onSelect={onRecentResume}
        recents={[
          {
            id: 'conv-resume',
            name: 'Prior chat',
            assistantId: undefined,
            assistantName: undefined,
            assistantIcon: undefined,
            modifyTime: 1,
          },
        ]}
      />
    </div>
  );
};

describe('new-chat starter wiring', () => {
  it('renders all 6 quick-launch anchor cards with Cowork first', () => {
    const { container } = render(
      <TestHarness onAssistantSelected={vi.fn()} onInputSet={vi.fn()} onRecentResume={vi.fn()} />
    );
    const cards = container.querySelectorAll('[data-quicklaunch-id]');
    expect(cards).toHaveLength(6);
    expect(cards[0].getAttribute('data-quicklaunch-id')).toBe('cowork');
  });

  it('routes built-in preset cards to the preset.presetAgentType backend (Rory rule)', () => {
    const onAssistantSelected = vi.fn();
    const onInputSet = vi.fn();
    const { container } = render(
      <TestHarness
        onAssistantSelected={onAssistantSelected}
        onInputSet={onInputSet}
        onRecentResume={vi.fn()}
      />
    );

    // Cowork is a built-in preset assistant (id: 'cowork').
    const coworkCard = container.querySelector('[data-quicklaunch-id="cowork"]') as HTMLButtonElement;
    fireEvent.click(coworkCard);

    const anchor = QUICK_LAUNCH_ANCHORS.find((a) => a.id === 'cowork');
    const preset = ASSISTANT_PRESETS.find((p) => p.id === 'cowork');
    expect(preset).toBeTruthy();
    expect(anchor!.assistantId).toBe('builtin-cowork');
    expect(onInputSet).toHaveBeenCalledWith(anchor!.prefill);
    expect((screen.getByTestId('harness-input') as HTMLInputElement).value).toBe(anchor!.prefill);
    expect(onAssistantSelected).toHaveBeenCalledWith(
      `custom:builtin-cowork@${preset!.presetAgentType ?? 'gemini'}`
    );
  });

  it('routes ext-* bundle cards via the gemini fallback (Rory rule)', () => {
    const onAssistantSelected = vi.fn();
    const onInputSet = vi.fn();
    const { container } = render(
      <TestHarness
        onAssistantSelected={onAssistantSelected}
        onInputSet={onInputSet}
        onRecentResume={vi.fn()}
      />
    );

    // write-copy → ext-copy bundle assistant (no preset in ASSISTANT_PRESETS).
    const card = container.querySelector('[data-quicklaunch-id="write-copy"]') as HTMLButtonElement;
    fireEvent.click(card);

    const anchor = QUICK_LAUNCH_ANCHORS.find((a) => a.id === 'write-copy');
    expect(onInputSet).toHaveBeenCalledWith(anchor!.prefill);
    expect(onAssistantSelected).toHaveBeenCalledWith('custom:ext-copy@gemini');
  });

  it('renders the View-all link and routes the click', () => {
    const onViewAll = vi.fn();
    render(
      <TestHarness
        onAssistantSelected={vi.fn()}
        onInputSet={vi.fn()}
        onRecentResume={vi.fn()}
        onViewAll={onViewAll}
      />
    );
    fireEvent.click(screen.getByText(/view all/i));
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });

  it('clicking a recents card resumes that conversation', () => {
    const onRecentResume = vi.fn();
    render(
      <TestHarness
        onAssistantSelected={vi.fn()}
        onInputSet={vi.fn()}
        onRecentResume={onRecentResume}
      />
    );

    fireEvent.click(screen.getAllByTestId('recents-card')[0]);
    expect(onRecentResume).toHaveBeenCalledWith(expect.objectContaining({ id: 'conv-resume' }));
  });
});
