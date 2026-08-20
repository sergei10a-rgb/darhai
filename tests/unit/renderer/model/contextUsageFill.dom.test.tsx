/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WHICH number the ring divides by.
 *
 * The ring computed its fill from `input_tokens + output_tokens`. Output tokens
 * are what came BACK from the model; what SITS IN the context window is the
 * input. On the engine contract fixture that sum reads 160 where the resident
 * truth is 120 - a 33% overstatement, and it grows with every turn.
 *
 * The engine also sends `active_window_percent`: its OWN measure of how full
 * the window is, needing no division against a limit we guessed from the model
 * id. That figure was discarded.
 *
 * So the fill has a PRECEDENCE, not a replacement - each source can be absent:
 *
 *   1. `activeWindowPercent`  the engine measured its own window. Exact.
 *   2. `inputTokens / limit`  what actually sits in the window, our division.
 *   3. `totalTokens / limit`  the legacy inflated sum. All a pre-widening
 *                             record on disk carries, so it must still render.
 *
 * HONESTY. The five-field claim these tests build on is proved from the
 * published contract schema and the code path (see
 * `tests/unit/wcore-contextUsageContract.test.ts`), NOT from a frame captured
 * off a running engine. A live engine may well omit `active_window_percent`;
 * that is exactly why this is a fallback chain and every step below is
 * exercised on its own.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ContextUsageIndicator, { resolveContextFill } from '@renderer/components/agent/ContextUsageIndicator';
import type { TokenUsageData } from '@/common/config/storage';

/** A turn where all three sources disagree, so the winner is unambiguous. */
const LIMIT = 200_000;
const FULL: TokenUsageData = {
  totalTokens: 160_000, // legacy sum  -> 80.0%
  inputTokens: 120_000, // resident    -> 60.0%
  outputTokens: 40_000,
  cacheReadTokens: 16,
  cacheWriteTokens: 8,
  activeWindowPercent: 37, // engine's own -> 37.0%
};

/** Open the hover popover and hand back the figure line. */
const readFigure = async (tokenUsage: TokenUsageData | null, contextLimit = LIMIT): Promise<string> => {
  const { container } = render(React.createElement(ContextUsageIndicator, { tokenUsage, contextLimit }));
  fireEvent.mouseEnter(container.querySelector('.context-usage-indicator') as HTMLElement);
  const figure = await waitFor(() => screen.getByTestId('context-usage-figure'));
  return figure.textContent ?? '';
};

const readBreakdown = async (tokenUsage: TokenUsageData | null, contextLimit = LIMIT): Promise<string> => {
  const { container } = render(React.createElement(ContextUsageIndicator, { tokenUsage, contextLimit }));
  fireEvent.mouseEnter(container.querySelector('.context-usage-indicator') as HTMLElement);
  const breakdown = await waitFor(() => screen.getByTestId('context-usage-breakdown'));
  return breakdown.textContent ?? '';
};

describe('resolveContextFill precedence', () => {
  it('prefers the engine’s own window measure over anything we could divide', () => {
    const fill = resolveContextFill(FULL, LIMIT);
    expect(fill.source).toBe('engineWindowPercent');
    expect(fill.percent).toBe(37);
  });

  it('falls back to input_tokens - not the inflated sum - when the engine sent no percent', () => {
    const { activeWindowPercent: _dropped, ...noPercent } = FULL;
    const fill = resolveContextFill(noPercent as TokenUsageData, LIMIT);
    expect(fill.source).toBe('inputTokens');
    // 120K of a 200K window. The old code said 80% here by folding in output.
    expect(fill.percent).toBeCloseTo(60, 6);
    expect(fill.used).toBe(120_000);
  });

  it('still reads a pre-widening record that carries only totalTokens', () => {
    // The migration case: nothing but the legacy sum survives on disk. It must
    // render as its own figure, not as zero and not as NaN.
    const fill = resolveContextFill({ totalTokens: 4200 }, LIMIT);
    expect(fill.source).toBe('legacyTotal');
    expect(fill.used).toBe(4200);
    expect(Number.isFinite(fill.percent)).toBe(true);
    expect(fill.percent).toBeGreaterThan(0);
  });

  it('treats a zero percent as a real reading, not as an absent one', () => {
    // A fresh window genuinely is 0% full. A truthiness check here would fall
    // through to input_tokens and report a window that is not empty.
    const fill = resolveContextFill({ ...FULL, activeWindowPercent: 0 }, LIMIT);
    expect(fill.source).toBe('engineWindowPercent');
    expect(fill.percent).toBe(0);
    expect(fill.used).toBe(0);
  });

  it('treats zero input_tokens as a real reading too', () => {
    const { activeWindowPercent: _dropped, ...noPercent } = FULL;
    const fill = resolveContextFill({ ...noPercent, inputTokens: 0 } as TokenUsageData, LIMIT);
    expect(fill.source).toBe('inputTokens');
    expect(fill.used).toBe(0);
  });

  it('steps past a corrupt figure instead of propagating NaN', () => {
    const dirty = { ...FULL, activeWindowPercent: Number.NaN };
    const fill = resolveContextFill(dirty, LIMIT);
    expect(fill.source).toBe('inputTokens');
    expect(Number.isFinite(fill.percent)).toBe(true);

    const worse = { ...dirty, inputTokens: Number.NaN };
    const last = resolveContextFill(worse as TokenUsageData, LIMIT);
    expect(last.source).toBe('legacyTotal');
    expect(Number.isFinite(last.percent)).toBe(true);
  });

  it('never divides by a limit the caller could not supply', () => {
    for (const limit of [0, -1, Number.NaN]) {
      const fill = resolveContextFill({ totalTokens: 1000 }, limit);
      expect(Number.isFinite(fill.percent), `limit=${limit}`).toBe(true);
    }
  });

  it('reports an empty fill for no usage at all', () => {
    const fill = resolveContextFill(null, LIMIT);
    expect(fill.percent).toBe(0);
    expect(fill.used).toBe(0);
  });
});

describe('the ring and its popover agree on whichever source won', () => {
  it('shows the engine’s percentage, not the inflated sum’s', async () => {
    // 37.0% is the engine's own reading. 80.0% is what input+output produced,
    // and 60.0% is what input alone would produce - both must lose here.
    const text = await readFigure(FULL);
    expect(text).toContain('37.0%');
    expect(text).not.toContain('80.0%');
    expect(text).not.toContain('60.0%');
  });

  it('states a used figure that matches the percentage it just printed', async () => {
    // The prior bug in this file was a popover contradicting itself. 37% of a
    // 200K window is 74K, and 74K + 126K free is the 200K limit on the line.
    const text = await readBreakdown(FULL);
    expect(text).toContain('74.0K');
    expect(text).toContain('126K');
  });

  it('shows input_tokens as used when the engine sent no percent', async () => {
    const { activeWindowPercent: _dropped, ...noPercent } = FULL;
    const figure = await readFigure(noPercent as TokenUsageData);
    expect(figure).toContain('60.0%');
    expect(figure).toContain('120.0K');
    const breakdown = await readBreakdown(noPercent as TokenUsageData);
    expect(breakdown).toContain('120.0K');
    expect(breakdown).toContain('80K'); // free = 200K - 120K, a whole magnitude
  });

  it('renders a legacy record rather than an empty or NaN ring', async () => {
    const figure = await readFigure({ totalTokens: 160_000 });
    expect(figure).toContain('80.0%');
    expect(figure).not.toContain('NaN');
  });

  it('draws the arc from the winning source', () => {
    const offsetFor = (usage: TokenUsageData): number => {
      const { container } = render(
        React.createElement(ContextUsageIndicator, { tokenUsage: usage, contextLimit: LIMIT })
      );
      const circles = container.querySelectorAll('circle');
      return Number(circles[circles.length - 1].getAttribute('stroke-dashoffset'));
    };
    const { activeWindowPercent: _dropped, ...noPercent } = FULL;
    const engine = offsetFor(FULL);
    const input = offsetFor(noPercent as TokenUsageData);
    // A 37%-full ring leaves MORE of the circle undrawn than a 60%-full one.
    expect(engine).toBeGreaterThan(input);
    expect(Number.isFinite(engine)).toBe(true);
  });
});
