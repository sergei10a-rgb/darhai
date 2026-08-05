/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * One breakdown panel: a titled list of bars sized to each bucket's share of
 * the largest bucket in the set. Used for by-model / by-backend / by-team /
 * by-conversation views.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import type { CostAggregate } from '@process/services/cost/types';
import { formatTokenCount, formatSpend } from '@renderer/utils/format/tokens';
import { useMntRate } from '@renderer/hooks/cost/useMntRate';
import { BudgetBar } from './BudgetBar';
import styles from './Cost.module.css';

export type CostBreakdownProps = {
  title: string;
  rows: CostAggregate[];
  /** Label shown for a row whose key is empty (unattributed bucket). */
  unattributedLabel: string;
  /** Cap on rows rendered; the rest are summed into nothing (just hidden). */
  limit?: number;
};

export const CostBreakdown: React.FC<CostBreakdownProps> = ({ title, rows, unattributedLabel, limit = 8 }) => {
  const { t } = useTranslation();
  const { toMnt } = useMntRate();
  const top = rows.slice(0, limit);
  const max = top.reduce((m, r) => (r.costUsd > m ? r.costUsd : m), 0);

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>{title}</span>
      </div>
      {top.length === 0 ? (
        <div className={styles.panelHint}>{t('missionControl.cost.noData')}</div>
      ) : (
        <div className={styles.bars}>
          {top.map((row) => (
            <div className={styles.barRow} key={`${row.key}`}>
              <div className={styles.barTop}>
                <span className={styles.barKey}>{row.key || unattributedLabel}</span>
                <span className={styles.barVal}>
                  {formatSpend(row.costUsd, toMnt(row.costUsd))} {'·'} {formatTokenCount(row.tokensTotal)}
                </span>
              </div>
              <BudgetBar fraction={max > 0 ? row.costUsd / max : 0} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
