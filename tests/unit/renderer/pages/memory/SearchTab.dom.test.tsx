/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * Wave 5 Task 5b -- DOM tests for SearchTab.
 *
 * Covers:
 *   - empty state renders the example queries
 *   - clicking an example chip fills the search input
 *   - submitting a query triggers useIjfwBrain with the `think` verb and the
 *     trimmed query
 *   - loading state renders the MCPVerbCard Spin
 *   - success renders the answer text and one citation badge per citation
 *   - citation click triggers the Wave 6 stub Message.info call
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { brainInvokeMock, messageInfoSpy } = vi.hoisted(() => ({
  brainInvokeMock: vi.fn<
    (args: { verb: string; args?: Record<string, unknown> }) => Promise<
      { ok: true; data?: unknown } | { ok: false; errorReason?: string }
    >
  >(),
  messageInfoSpy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    ijfw: {
      brainInvoke: { invoke: brainInvokeMock },
    },
  },
}));

vi.mock('@arco-design/web-react', async () => {
  const actual =
    await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return {
    ...actual,
    Message: {
      ...actual.Message,
      info: messageInfoSpy,
    },
  };
});

import SearchTab from '@renderer/pages/memory/tabs/SearchTab';

beforeEach(() => {
  brainInvokeMock.mockReset();
  messageInfoSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

const getSearchInput = (): HTMLInputElement => {
  const inputs = document.querySelectorAll('input');
  // Input.Search renders a single text input.
  const input = Array.from(inputs).find(
    (el) => el.getAttribute('type') !== 'hidden'
  ) as HTMLInputElement | undefined;
  if (!input) throw new Error('search input not found');
  return input;
};

describe('SearchTab', () => {
  it('renders the empty state with three example chips and no result panel', () => {
    // Hold the promise open so the hook stays in initial state. The empty
    // state is gated on the active query being empty -- not on loading --
    // so the hook should not even be invoked yet.
    brainInvokeMock.mockReturnValue(new Promise(() => {}));
    render(<SearchTab />);

    expect(screen.getByTestId('memory-search-empty')).toBeTruthy();
    expect(screen.getByTestId('memory-search-example-example_1')).toBeTruthy();
    expect(screen.getByTestId('memory-search-example-example_2')).toBeTruthy();
    expect(screen.getByTestId('memory-search-example-example_3')).toBeTruthy();
    expect(screen.queryByTestId('memory-search-result')).toBeNull();
  });

  it('fills the input when an example chip is clicked', () => {
    brainInvokeMock.mockReturnValue(new Promise(() => {}));
    render(<SearchTab />);

    fireEvent.click(screen.getByTestId('memory-search-example-example_1'));

    const input = getSearchInput();
    expect(input.value).toBe('memory.search.example_1');
    // Click alone must not submit -- empty state should remain.
    expect(screen.getByTestId('memory-search-empty')).toBeTruthy();
    expect(brainInvokeMock).not.toHaveBeenCalled();
  });

  it('submits the query and invokes the think verb on Enter', async () => {
    brainInvokeMock.mockReturnValue(new Promise(() => {}));
    render(<SearchTab />);

    const input = getSearchInput();
    fireEvent.change(input, { target: { value: '  what is the auth stack  ' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });

    // Wait one microtask for the effect dispatch.
    await Promise.resolve();

    expect(brainInvokeMock).toHaveBeenCalledTimes(1);
    expect(brainInvokeMock).toHaveBeenCalledWith({
      verb: 'think',
      args: { query: 'what is the auth stack', k: 5 },
    });
    // Empty state is gone, loading spinner has taken its place.
    expect(screen.queryByTestId('memory-search-empty')).toBeNull();
    expect(screen.getByTestId('mcp-verb-card-loading')).toBeTruthy();
  });

  it('does not submit when the query is whitespace only', () => {
    brainInvokeMock.mockReturnValue(new Promise(() => {}));
    render(<SearchTab />);

    const input = getSearchInput();
    fireEvent.change(input, { target: { value: '    ' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });

    expect(brainInvokeMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('memory-search-empty')).toBeTruthy();
  });

  it('renders the answer and one citation badge per citation on success', async () => {
    brainInvokeMock.mockResolvedValueOnce({
      ok: true,
      data: {
        answer: 'We use Clerk on Postgres.',
        citations: [
          { source: 'decisions/auth.md', snippet: 'Auth: Clerk' },
          { source: 'PROJECT.md', snippet: 'Postgres via Neon' },
        ],
      },
    });

    render(<SearchTab />);
    const input = getSearchInput();
    fireEvent.change(input, { target: { value: 'auth' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });

    const result = await screen.findByTestId('memory-search-result');
    expect(result.textContent).toContain('We use Clerk on Postgres.');

    const badges = screen.getAllByTestId('memory-search-citation');
    expect(badges).toHaveLength(2);
    expect(badges[0]?.textContent).toContain('decisions/auth.md');
    expect(badges[1]?.textContent).toContain('PROJECT.md');
  });

  it('shows the Wave 6 stub Message when a citation is clicked', async () => {
    brainInvokeMock.mockResolvedValueOnce({
      ok: true,
      data: {
        answer: 'Answer body.',
        citations: [{ source: 'notes/x.md', snippet: 'x' }],
      },
    });

    render(<SearchTab />);
    const input = getSearchInput();
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });

    const badge = await screen.findByTestId('memory-search-citation');
    fireEvent.click(badge);

    expect(messageInfoSpy).toHaveBeenCalledTimes(1);
    expect(messageInfoSpy).toHaveBeenCalledWith('memory.search.citation_stub');
  });
});
