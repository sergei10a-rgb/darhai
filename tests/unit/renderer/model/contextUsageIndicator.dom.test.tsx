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
import ContextUsageIndicator, { formatTokenCount } from '@renderer/components/agent/ContextUsageIndicator';

/**
 * The three figures in the popover have to add up.
 *
 * A screenshot of the running app read `14.5% · 152.0K / 1M` above
 * `Used: 152.0K   Free: 896.6K` - and 152 + 896.6 is not 1000. The cause was in
 * `hideZeroDecimals`: it ran `toFixed(1)` FIRST and then `Math.floor` on the
 * unrounded value, so it did not hide a `.0`, it truncated a real fraction. The
 * default window is 1_048_576, which lands exactly in that hole, so the most
 * common case on screen silently dropped 48_576 tokens - and only the free
 * figure, formatted through a different magnitude, gave it away.
 *
 * The flag's own docstring says "show 1M instead of 1.0M", which is only ever
 * true of a whole magnitude. That is what these tests pin.
 */
describe('formatTokenCount', () => {
  it('drops the decimal only when the magnitude is genuinely whole', () => {
    // Exactly 1M: nothing is being hidden, so the tidy form is honest.
    expect(formatTokenCount(1_000_000, true)).toBe('1M');
    // The default context window. `1M` here is a 48_576-token lie.
    expect(formatTokenCount(1_048_576, true)).toBe('1.0M');
    // Same trap one magnitude down.
    expect(formatTokenCount(204_800, true)).toBe('204.8K');
    expect(formatTokenCount(200_000, true)).toBe('200K');
  });

  it('never reports a smaller number than it rounded to', () => {
    // 999_999 rounds to "1000.0K", but the old floor took 999 from the
    // UNROUNDED value and printed "999K" - a figure lower than both.
    expect(formatTokenCount(999_999, true)).toBe('1000.0K');
  });

  it('keeps the popover self-consistent: used + free reads as the limit', () => {
    const limit = 1_048_576;
    const used = 152_000;
    // These are the exact three strings the popover renders side by side.
    expect(formatTokenCount(used)).toBe('152.0K');
    expect(formatTokenCount(limit, true)).toBe('1.0M');
    expect(formatTokenCount(limit - used, true)).toBe('896.6K');
    // 152.0K + 896.6K = 1048.6K, which rounds to the 1.0M shown as the limit.
    expect(formatTokenCount(used + (limit - used), true)).toBe('1.0M');
  });

  it('is unchanged when the flag is off', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
    expect(formatTokenCount(1_048_576)).toBe('1.0M');
    expect(formatTokenCount(999)).toBe('999');
  });
});

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

/**
 * The context breakdown and the tögrög cost readout.
 *
 * The ring alone says "how full", not "of what" and not "what has it cost". The
 * popover now names both halves of the window (used / free) and, when the cost
 * service has a figure for this chat, prints it in tögrög. The rules the display
 * must not break: free never goes negative past the window, the cost row is a
 * real recorded number (never a $0.00 placeholder), and a missing rate falls
 * back to dollars rather than inventing a tögrög figure.
 */
describe('ContextUsageIndicator breakdown and spend', () => {
  const open = (props: Record<string, unknown>): HTMLElement => {
    const { container } = render(
      React.createElement(ContextUsageIndicator, props as unknown as React.ComponentProps<typeof ContextUsageIndicator>)
    );
    fireEvent.mouseEnter(container.querySelector('.context-usage-indicator') as HTMLElement);
    return container;
  };

  it('names the used and free halves of the window', async () => {
    open({ tokenUsage: { totalTokens: 50_000 }, contextLimit: 200_000 });
    const breakdown = await screen.findByTestId('context-usage-breakdown');
    // 50K used of a 200K window leaves 150K free - both must be legible.
    expect(breakdown.textContent ?? '').toContain('50.0K');
    expect(breakdown.textContent ?? '').toContain('150K');
  });

  it('never reports negative free space once the window overflows', async () => {
    open({ tokenUsage: { totalTokens: 1_400_000 }, contextLimit: 1_000_000 });
    const breakdown = await screen.findByTestId('context-usage-breakdown');
    // Overflowed by 400K: free is clamped at 0, never "-400K".
    expect(breakdown.textContent ?? '').not.toContain('-');
    expect(breakdown.textContent ?? '').toContain('0');
  });

  it('shows the tögrög cost when the cost service supplies one', async () => {
    open({ tokenUsage: { totalTokens: 50_000 }, contextLimit: 200_000, spendUsd: 0.5, spendMnt: 1750 });
    const spend = await screen.findByTestId('context-usage-spend');
    // Dollars first, tögrög alongside - the shared formatSpend convention.
    expect(spend.textContent ?? '').toContain('$0.50');
    expect(spend.textContent ?? '').toContain('1,750₮');
  });

  it('falls back to dollars alone when no rate is known', async () => {
    open({ tokenUsage: { totalTokens: 50_000 }, contextLimit: 200_000, spendUsd: 0.5, spendMnt: null });
    const spend = await screen.findByTestId('context-usage-spend');
    expect(spend.textContent ?? '').toContain('$0.50');
    expect(spend.textContent ?? '').not.toContain('₮');
  });

  it('hides the cost row entirely when spend is zero or unknown', () => {
    // A zero spend must not render as "$0.00" - that reads as a measured
    // nothing, when the truth is the turn simply has not been priced yet.
    open({ tokenUsage: { totalTokens: 50_000 }, contextLimit: 200_000, spendUsd: 0 });
    expect(screen.queryByTestId('context-usage-spend')).toBeNull();
    open({ tokenUsage: { totalTokens: 50_000 }, contextLimit: 200_000 });
    expect(screen.queryByTestId('context-usage-spend')).toBeNull();
  });
});
