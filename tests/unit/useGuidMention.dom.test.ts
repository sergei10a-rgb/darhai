/**
 * Unit tests for `useGuidMention`'s `selectedAgentLabel`.
 *
 * `availableAgents` reaches the Guid page over SWR, so on the very first frame
 * it is `undefined` and `selectedAgentInfo` is undefined with it. The label has
 * to survive that frame without leaking the internal backend id ("wcore") into
 * the UI - it feeds three user-visible surfaces in GuidPage.tsx: the composer
 * placeholder, the mention selector badge, and the preset hero title.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/renderer/utils/model/agentLogo', () => ({
  getAgentLogo: (): undefined => undefined,
}));

vi.mock('@/renderer/pages/guid/constants', () => ({
  CUSTOM_AVATAR_IMAGE_MAP: {},
}));

import { useGuidMention } from '@/renderer/pages/guid/hooks/useGuidMention';
import type { AvailableAgent } from '@/renderer/pages/guid/types';

/** Render the hook the way GuidPage does, with only the inputs under test varied. */
const renderLabel = (options: { availableAgents: AvailableAgent[] | undefined; selectedAgentKey: string }) => {
  const { result } = renderHook(() =>
    useGuidMention({
      availableAgents: options.availableAgents,
      customAgentAvatarMap: new Map<string, string | undefined>(),
      selectedAgentKey: options.selectedAgentKey,
      setSelectedAgentKey: vi.fn(),
      setInput: vi.fn(),
      selectedAgentInfo: options.availableAgents?.find((agent) => agent.backend === options.selectedAgentKey),
    })
  );
  return result.current.selectedAgentLabel;
};

describe('useGuidMention - selectedAgentLabel', () => {
  it('shows the user-facing backend name while availableAgents is still undefined', () => {
    // Arrange: first frame - SWR has not resolved, default key from useGuidAgentSelection.
    // Act
    const label = renderLabel({ availableAgents: undefined, selectedAgentKey: 'wcore' });

    // Assert
    expect(label).toBe('Darhai Core');
    expect(label).not.toBe('wcore');
  });

  it('does not leak any raw lower-case backend id for known backends on the first frame', () => {
    for (const key of ['wcore', 'claude', 'gemini', 'codex']) {
      const label = renderLabel({ availableAgents: undefined, selectedAgentKey: key });
      expect(label).not.toBe(key);
      expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
    }
  });

  it('degrades sensibly for an unknown backend id instead of rendering empty or "undefined"', () => {
    // Arrange / Act: a backend that is not in BACKEND_LABEL at all.
    const label = renderLabel({ availableAgents: undefined, selectedAgentKey: 'mysteryengine' });

    // Assert: readable, and never the two failure strings the composer would show.
    expect(label).toBe('Mysteryengine');
    expect(label).not.toBe('');
    expect(label).not.toBe('undefined');
    expect(label).not.toContain('undefined');
  });

  it('does not leak a raw custom-agent uuid key on the first frame', () => {
    // `getAgentKey` produces composite keys for custom/remote agents.
    const label = renderLabel({
      availableAgents: undefined,
      selectedAgentKey: 'custom:6f2a1c74-0f4b-4f2e-9a3d-91c0f0a1b2c3',
    });

    expect(label).toBe('Custom');
    expect(label).not.toContain('6f2a1c74');
  });

  it('prefers the real agent name once availableAgents has resolved', () => {
    const agents: AvailableAgent[] = [{ backend: 'wcore', name: 'Darhai Core' }];

    const label = renderLabel({ availableAgents: agents, selectedAgentKey: 'wcore' });

    expect(label).toBe('Darhai Core');
  });

  it('keeps a custom agent display name that differs from its backend label', () => {
    const agents: AvailableAgent[] = [{ backend: 'wcore', name: 'My Tuned Core' }];

    const label = renderLabel({ availableAgents: agents, selectedAgentKey: 'wcore' });

    expect(label).toBe('My Tuned Core');
  });
});

describe('useGuidMention - mention dropdown option labels', () => {
  it('labels an agent by its backend display name when the agent carries no name', () => {
    // Some detected agents arrive with an empty `name`; the dropdown row used to
    // fall back to `agent.backend`, printing the same raw "wcore" id.
    const agents: AvailableAgent[] = [{ backend: 'wcore', name: '' }];

    const { result } = renderHook(() =>
      useGuidMention({
        availableAgents: agents,
        customAgentAvatarMap: new Map<string, string | undefined>(),
        selectedAgentKey: 'wcore',
        setSelectedAgentKey: vi.fn(),
        setInput: vi.fn(),
        selectedAgentInfo: undefined,
      })
    );

    expect(result.current.mentionOptions[0]?.label).toBe('Darhai Core');
  });

  it('still matches "@wcore" typed by id after the label is humanized', () => {
    // The raw backend id stays in the search tokens, so muscle memory keeps working.
    const agents: AvailableAgent[] = [{ backend: 'wcore', name: '' }];

    const { result } = renderHook(() =>
      useGuidMention({
        availableAgents: agents,
        customAgentAvatarMap: new Map<string, string | undefined>(),
        selectedAgentKey: 'wcore',
        setSelectedAgentKey: vi.fn(),
        setInput: vi.fn(),
        selectedAgentInfo: undefined,
      })
    );

    expect(Array.from(result.current.mentionOptions[0]?.tokens ?? [])).toContain('wcore');
  });
});
