/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The context ring that drew a corrupt arc.
 *
 * The percentage was computed unclamped and fed straight into the SVG's
 * `stroke-dashoffset`. Once usage passed the window - which happens on a long
 * turn - the offset went negative and the ring rendered as a garbled shape
 * instead of a full circle. A zero or missing limit divided by zero and
 * produced `Infinity`, and a non-finite token count poisoned the same
 * arithmetic.
 *
 * These are the three inputs a caller can realistically produce, so the
 * component has to survive all three: over-budget usage, an absent limit, and
 * a missing count.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ContextUsageIndicator from '@renderer/components/agent/ContextUsageIndicator';

/** The ring's dash offset, which is what a bad percentage corrupts. */
function dashOffsetOf(container: HTMLElement): number {
  const circles = container.querySelectorAll('circle');
  const ring = circles[circles.length - 1];
  return Number(ring.getAttribute('stroke-dashoffset'));
}

describe('ContextUsageIndicator', () => {
  it('draws a full ring - not a negative offset - when usage exceeds the window', () => {
    const { container } = render(
      React.createElement(ContextUsageIndicator, {
        tokenUsage: { totalTokens: 3_000_000 },
        contextLimit: 200_000,
      })
    );
    // Unclamped this was 1500%, driving the offset far below zero.
    expect(dashOffsetOf(container)).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(dashOffsetOf(container))).toBe(true);
  });

  it('stays finite when the caller passes no usable limit', () => {
    for (const contextLimit of [0, -1, Number.NaN]) {
      const { container } = render(
        React.createElement(ContextUsageIndicator, {
          tokenUsage: { totalTokens: 1000 },
          contextLimit,
        })
      );
      expect(Number.isFinite(dashOffsetOf(container)), `limit=${contextLimit}`).toBe(true);
    }
  });

  it('stays finite when the token count itself is not a number', () => {
    const { container } = render(
      React.createElement(ContextUsageIndicator, {
        tokenUsage: { totalTokens: Number.NaN as unknown as number },
        contextLimit: 200_000,
      })
    );
    expect(Number.isFinite(dashOffsetOf(container))).toBe(true);
  });

  it('still renders an ordinary partial ring below the limit', () => {
    const { container } = render(
      React.createElement(ContextUsageIndicator, {
        tokenUsage: { totalTokens: 100_000 },
        contextLimit: 200_000,
      })
    );
    const offset = dashOffsetOf(container);
    // Half full: strictly between empty and full, so the clamp did not flatten
    // the normal case into a constant.
    expect(offset).toBeGreaterThan(0);
    expect(Number.isFinite(offset)).toBe(true);
  });

  it('renders nothing at all without token data', () => {
    const { container } = render(React.createElement(ContextUsageIndicator, { tokenUsage: null }));
    expect(container.querySelector('circle')).toBeNull();
  });
});

/**
 * The ring clamp must not silence the NUMBER.
 *
 * A user hovering an over-budget conversation read "100.0% . 1.4M / 1M" - the
 * percentage was clamped alongside the ring, so a 40% overrun was displayed as
 * a tidy 100% and the two halves of the same line contradicted each other.
 */
describe('ContextUsageIndicator readout', () => {
  /** The readout lives in a hover popover, so open it before reading. */
  const openReadout = async (usage: number, limit: number): Promise<HTMLElement> => {
    const { container } = render(
      React.createElement(ContextUsageIndicator, { tokenUsage: { totalTokens: usage }, contextLimit: limit })
    );
    fireEvent.mouseEnter(container.querySelector('.context-usage-indicator') as HTMLElement);
    return waitFor(() => screen.getByTestId('context-usage-figure'));
  };

  it('reports the TRUE percentage past the window, not a clamped 100', async () => {
    // The measured case: 1.4M against a 1M window.
    const figure = await openReadout(1_400_000, 1_000_000);
    expect(figure.textContent ?? '').toContain('140.0%');
  });

  it('is unchanged below the window', async () => {
    const figure = await openReadout(100_000, 200_000);
    expect(figure.textContent ?? '').toContain('50.0%');
  });

  it('surfaces an over-limit notice only when actually over', async () => {
    await openReadout(1_400_000, 1_000_000);
    expect(screen.queryByTestId('context-usage-over')).not.toBeNull();
  });

  it('shows no over-limit notice below the window', async () => {
    await openReadout(100_000, 200_000);
    expect(screen.queryByTestId('context-usage-over')).toBeNull();
  });
});
