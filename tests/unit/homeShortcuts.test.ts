/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The three shortcuts the home hint bar advertises must actually work.
 *
 * Measured before this fix: Ctrl+K had a handler but `skipInputs` dropped it
 * the moment focus entered the composer (the first thing anyone does on that
 * screen); Tab had NO handler at all and the agent pills are click-only
 * `<div>`s with no tabIndex, so the press fell through to the browser's focus
 * move; Ctrl+N had no handler either - the implemented binding was Ctrl+T.
 * The bar promised three things and delivered none.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { AcpBackend } from '@/common/types/acpTypes';
import { cycleAgentKey, getAgentKey } from '@/renderer/pages/guid/hooks/agentSelectionUtils';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, '..', rel), 'utf8');

type Agent = { backend: AcpBackend; customAgentId?: string };
const AGENTS: Agent[] = [
  { backend: 'wcore' as AcpBackend },
  { backend: 'gemini' as AcpBackend },
  { backend: 'claude' as AcpBackend },
];

describe('Tab cycles the agent pill', () => {
  it('moves forward and wraps around at the end', () => {
    expect(cycleAgentKey(AGENTS, 'wcore', 1)).toBe('gemini');
    expect(cycleAgentKey(AGENTS, 'gemini', 1)).toBe('claude');
    expect(cycleAgentKey(AGENTS, 'claude', 1)).toBe('wcore');
  });

  it('Shift+Tab moves backward and wraps around at the start', () => {
    expect(cycleAgentKey(AGENTS, 'claude', -1)).toBe('gemini');
    expect(cycleAgentKey(AGENTS, 'wcore', -1)).toBe('claude');
  });

  it('handles custom / remote agent keys, not just plain backends', () => {
    const withCustom: Agent[] = [
      { backend: 'wcore' as AcpBackend },
      { backend: 'acp' as AcpBackend, customAgentId: 'abc' },
    ];
    expect(getAgentKey(withCustom[1])).toBe('custom:abc');
    expect(cycleAgentKey(withCustom, 'wcore', 1)).toBe('custom:abc');
    expect(cycleAgentKey(withCustom, 'custom:abc', 1)).toBe('wcore');
  });

  it('returns null when there is nothing to cycle to, so Tab keeps its default meaning', () => {
    expect(cycleAgentKey(undefined, 'wcore', 1)).toBeNull();
    expect(cycleAgentKey([], 'wcore', 1)).toBeNull();
    expect(cycleAgentKey([{ backend: 'wcore' as AcpBackend }], 'wcore', 1)).toBeNull();
    // Unknown current key - never guess a starting point.
    expect(cycleAgentKey(AGENTS, 'nonexistent', 1)).toBeNull();
  });
});

describe('Ctrl+K reaches the palette from inside the composer', () => {
  it('the Layout palette binding opts out of skipInputs', () => {
    const layout = read('src/renderer/components/layout/Layout.tsx');
    expect(layout).toMatch(/useGlobalKeybind\('k',\s*togglePalette,\s*\{[^}]*skipInputs:\s*false/s);
  });

  it('a bare "k" still cannot open it - the modifier is required', () => {
    const layout = read('src/renderer/components/layout/Layout.tsx');
    expect(layout).toMatch(/useGlobalKeybind\('k',\s*togglePalette,\s*\{[^}]*meta:\s*true/s);
  });
});

describe('Ctrl+N opens a new chat', () => {
  const source = read('src/renderer/hooks/ui/useConversationShortcuts.ts');

  it('accepts both the tab (T) and new-document (N) conventions', () => {
    expect(source).toMatch(/key === 't' \|\| key === 'n'/);
  });

  it('still requires the Cmd/Ctrl modifier and rejects Alt/Shift combinations', () => {
    expect(source).toMatch(
      /if \(!\(event\.metaKey \|\| event\.ctrlKey\) \|\| event\.altKey \|\| event\.shiftKey\) return false;/
    );
  });
});

describe('the hint bar names exactly what is implemented', () => {
  it('advertises mod+K, Tab and mod+N - all three now backed by handlers', () => {
    const bar = read('src/renderer/pages/guid/components/HomeHintBar.tsx');
    expect(bar).toContain("formatShortcut(['mod', 'K'])");
    expect(bar).toContain("formatShortcut(['tab'])");
    expect(bar).toContain("formatShortcut(['mod', 'N'])");
  });

  it('the composer wires Tab to the cycle helper', () => {
    const page = read('src/renderer/pages/guid/GuidPage.tsx');
    expect(page).toContain('cycleAgentKey(visibleAgents');
    // Guarded so a modifier combo (e.g. Ctrl+Tab conversation cycling) is not stolen.
    expect(page).toMatch(/event\.key === 'Tab' &&\s*!event\.ctrlKey/);
  });
});
