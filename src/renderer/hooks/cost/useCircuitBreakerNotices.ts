/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Always-mounted listener for the cost circuit-breaker notices.
 *
 * Mounted from Layout (not the Mission Control cost tab) on purpose: the
 * breaker stops RUNNING agents from the main process, and the person watching
 * a conversation must learn why everything just stopped even if they have
 * never opened the cost page. The existing `cost.budgetAlert` listener lives
 * in BudgetsPanel and is therefore lost when the tab is closed - that gap is
 * exactly what this hook avoids for the breaker.
 */

import { Notification } from '@arco-design/web-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';

/** Spend/limit formatted in the cap's own currency for the notice body. */
function formatAmount(amountUsd: number, currency: 'MNT' | 'USD', limitUsd: number, limitAmount: number): string {
  if (currency === 'MNT' && limitUsd > 0) {
    const mnt = (amountUsd / limitUsd) * limitAmount;
    return `${Math.round(mnt).toLocaleString('en-US')}₮`;
  }
  return `$${amountUsd.toFixed(2)}`;
}

export function useCircuitBreakerNotices(): void {
  const { t } = useTranslation();

  useEffect(() => {
    const offWarning = ipcBridge.cost.circuitBreakerWarning.on((notice) => {
      if (notice.reason === 'rate_unavailable') {
        // H1: an MNT cap is armed but no exchange rate is known, so the kill
        // switch is temporarily NOT enforced. Sticky - the user believes a
        // protection is active that currently is not.
        Notification.warning({
          title: t('missionControl.cost.circuitBreaker.rateMissingTitle'),
          content: t('missionControl.cost.circuitBreaker.rateMissingBody', {
            limit: Math.round(notice.limitAmount).toLocaleString('en-US'),
          }),
          duration: 0,
        });
        return;
      }
      Notification.warning({
        title: t('missionControl.cost.circuitBreaker.warnTitle'),
        content: t('missionControl.cost.circuitBreaker.warnBody', {
          spent: formatAmount(notice.spentUsd, notice.currency, notice.limitUsd, notice.limitAmount),
          limit: formatAmount(notice.limitUsd, notice.currency, notice.limitUsd, notice.limitAmount),
        }),
        duration: 8000,
      });
    });

    const offTripped = ipcBridge.cost.circuitBreakerTripped.on((trip) => {
      // H2/M4: the breaker is reactive (it runs AFTER a turn's cost lands), so
      // most trips stop zero agents. "0 agents were stopped" reads as a bug;
      // say instead that the cap is exceeded and how to continue.
      const bodyKey =
        trip.stoppedCount > 0
          ? 'missionControl.cost.circuitBreaker.tripBody'
          : 'missionControl.cost.circuitBreaker.tripBodyNoAgents';
      Notification.error({
        title: t('missionControl.cost.circuitBreaker.tripTitle'),
        content: t(bodyKey, {
          spent: formatAmount(trip.spentUsd, trip.currency, trip.limitUsd, trip.limitAmount),
          limit: formatAmount(trip.limitUsd, trip.currency, trip.limitUsd, trip.limitAmount),
          stopped: trip.stoppedCount,
        }),
        // Sticky: the user must see WHY their agents stopped; they dismiss it.
        duration: 0,
      });
    });

    return () => {
      offWarning();
      offTripped();
    };
  }, [t]);
}
