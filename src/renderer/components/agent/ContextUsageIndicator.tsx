/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { Popover } from '@arco-design/web-react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { TokenUsageData } from '@/common/config/storage';

// Import default context limit from modelContextLimits
import { DEFAULT_CONTEXT_LIMIT } from '@/renderer/utils/model/modelContextLimits';
// Shared spend formatter - keeps "$X · Y₮" identical to every other cost surface.
import { formatSpend } from '@/renderer/utils/format/tokens';

interface ContextUsageIndicatorProps {
  tokenUsage: TokenUsageData | null;
  contextLimit?: number;
  className?: string;
  size?: number;
  /**
   * This conversation's real cumulative spend in USD, sourced from the cost
   * service (cost_events), or null when it is unknown or zero. Passed in rather
   * than fetched here so the component stays presentational and its import graph
   * stays free of the IPC bridge.
   */
  spendUsd?: number | null;
  /**
   * The same spend converted to tögrög with the shared rate, or null when no
   * rate is trustworthy. Never guessed - the caller resolves it through the
   * cost service's rate (useMntRate), so a missing rate simply shows dollars.
   */
  spendMnt?: number | null;
}

const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = ({
  tokenUsage,
  contextLimit = DEFAULT_CONTEXT_LIMIT,
  className = '',
  size = 24,
  spendUsd = null,
  spendMnt = null,
}) => {
  const { t } = useTranslation();

  const { percentage, truePercentage, isOverLimit, displayTotal, displayLimit, displayFree, isWarning, isDanger } =
    useMemo(() => {
      // A zero or missing limit would divide by zero and a negative one would
      // invert the ring; either way the caller has told us nothing useful, so
      // fall back rather than render a nonsense arc.
      const limit = Number.isFinite(contextLimit) && contextLimit > 0 ? contextLimit : DEFAULT_CONTEXT_LIMIT;

      if (!tokenUsage) {
        return {
          percentage: 0,
          truePercentage: 0,
          isOverLimit: false,
          displayTotal: '0',
          displayLimit: formatTokenCount(limit, true),
          displayFree: formatTokenCount(limit, true),
          isWarning: false,
          isDanger: false,
        };
      }

      const total = Number.isFinite(tokenUsage.totalTokens) ? tokenUsage.totalTokens : 0;
      const rawPct = Math.max(0, (total / limit) * 100);
      // Clamp the RING only: usage above the window is real (an over-long turn),
      // but an unclamped percentage drives the dash offset negative and draws a
      // corrupt arc. Past 100% the ring is simply full.
      const pct = Math.min(100, rawPct);

      return {
        percentage: pct,
        // The TEXT keeps the true figure. Clamping both produced the reading a
        // user reported: "100.0% · 1.4M / 1M" - internally contradictory, and it
        // hid a 40% overrun behind a number that looked merely maxed out.
        truePercentage: rawPct,
        isOverLimit: rawPct > 100,
        displayTotal: formatTokenCount(total),
        displayLimit: formatTokenCount(limit, true),
        // Free is clamped at zero: once a turn overflows the window there is no
        // negative headroom to report, and a "-200K" here would read as nonsense
        // next to a full ring.
        displayFree: formatTokenCount(Math.max(0, limit - total), true),
        isWarning: pct > 70,
        isDanger: pct > 90,
      };
    }, [tokenUsage, contextLimit]);

  // Hide when there is no token data
  if (!tokenUsage) {
    return null;
  }

  // Compute ring parameters
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  // Choose color based on state
  const getStrokeColor = () => {
    if (isDanger) return 'rgb(var(--danger-6))';
    if (isWarning) return 'rgb(var(--warning-6))';
    return 'rgb(var(--primary-6))';
  };

  // Background ring color - adapts to light/dark themes
  const getTrackColor = () => {
    return 'var(--color-fill-3)';
  };

  // Real spend for this chat, shown only when the cost service actually knows a
  // figure. A zero or missing value hides the row rather than printing "$0.00",
  // which would read as a measured "nothing" instead of "not yet recorded".
  const hasSpend = typeof spendUsd === 'number' && Number.isFinite(spendUsd) && spendUsd > 0;

  const popoverContent = (
    <div className='p-8px min-w-200px flex flex-col gap-8px'>
      <div className='text-14px font-medium text-t-primary' data-testid='context-usage-figure'>
        {truePercentage.toFixed(1)}% · {displayTotal} / {displayLimit}{' '}
        {t('conversation.contextUsage.contextUsed', 'context used')}
      </div>

      {/* Used vs free breakdown - the figure line gives the ratio, this gives
          it a shape and names both halves so the number is legible at a glance. */}
      <div data-testid='context-usage-breakdown'>
        <div className='h-6px rd-full overflow-hidden' style={{ backgroundColor: 'var(--color-fill-3)' }}>
          <div
            className='h-full rd-full'
            style={{ width: `${percentage}%`, backgroundColor: getStrokeColor(), transition: 'width 0.3s ease' }}
          />
        </div>
        <div className='flex justify-between text-12px text-t-secondary mt-4px'>
          <span>
            {t('conversation.contextUsage.used', 'Used')}: <span className='text-t-primary'>{displayTotal}</span>
          </span>
          <span>
            {t('conversation.contextUsage.free', 'Free')}: <span className='text-t-primary'>{displayFree}</span>
          </span>
        </div>
      </div>

      {/* This chat's real cumulative cost, priced by the cost service and shown
          in tögrög when a rate is known. Never a guess - hidden when unknown. */}
      {hasSpend ? (
        <div className='flex justify-between text-12px text-t-secondary' data-testid='context-usage-spend'>
          <span>{t('conversation.contextUsage.spend', "This chat's cost")}</span>
          <span className='text-t-primary font-medium'>{formatSpend(spendUsd as number, spendMnt ?? null)}</span>
        </div>
      ) : null}

      {isOverLimit ? (
        // Past the window the ring is simply full, so without this line the
        // display is identical at 101% and 400% - the user gets no signal that
        // the only real remedy is a new conversation.
        <div className='text-12px' style={{ color: 'rgb(var(--danger-6))' }} data-testid='context-usage-over'>
          {t('conversation.contextUsage.overLimit', 'Over the limit - start a new chat')}
        </div>
      ) : null}
    </div>
  );

  return (
    <Popover content={popoverContent} position='top' trigger='hover' className='context-usage-popover'>
      <div
        className={`context-usage-indicator cursor-pointer flex items-center justify-center ${className}`}
        style={{ width: size, height: size }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
          {/* Background ring */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill='none'
            stroke={getTrackColor()}
            strokeWidth={strokeWidth}
          />
          {/* Progress ring */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill='none'
            stroke={getStrokeColor()}
            strokeWidth={strokeWidth}
            strokeLinecap='round'
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            style={{ transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease' }}
          />
        </svg>
      </div>
    </Popover>
  );
};

/**
 * Format token count for display
 *
 * `hideZeroDecimals` tidies a WHOLE magnitude - 1_000_000 reads "1M" rather
 * than "1.0M". It must not tidy anything else.
 *
 * The test for "whole" is the value itself, not its rounded text. Checking
 * `toFixed(1).endsWith('.0')` and then flooring the UNROUNDED value made the
 * two disagree, and the flag stopped hiding a decimal and started truncating a
 * real fraction: the default 1_048_576-token window printed as "1M", dropping
 * 48_576 tokens, and 999_999 - which rounds UP to "1000.0K" - printed as the
 * smaller "999K". On screen the loss showed up as a popover that contradicted
 * itself, because the free figure beside it was formatted through a different
 * magnitude and kept its precision.
 *
 * @param count token count
 * @param hideZeroDecimals when true, drop the ".0" for a whole magnitude (e.g. "1M" not "1.0M"); defaults to false
 * @returns formatted string such as "37.0K" or "1.2M"
 */
export function formatTokenCount(count: number, hideZeroDecimals = false): string {
  if (count >= 1_000_000) {
    const value = count / 1_000_000;
    return hideZeroDecimals && Number.isInteger(value) ? `${value}M` : `${value.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const value = count / 1_000;
    return hideZeroDecimals && Number.isInteger(value) ? `${value}K` : `${value.toFixed(1)}K`;
  }
  return count.toString();
}

export default ContextUsageIndicator;
