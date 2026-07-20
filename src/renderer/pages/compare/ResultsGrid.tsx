/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Spin, Tag } from '@arco-design/web-react';
import { AlertCircle, Check } from 'lucide-react';
import type { CompareResult, CompareRunResult } from '@/common/types/compare';
import styles from './Compare.module.css';

type ResultsGridProps = {
  result: CompareResult;
  /** When true, model identity is hidden behind an alias until `revealed`. */
  blind: boolean;
  revealed: boolean;
};

/** A shuffled index order so blind mode does not leak identity by position. */
function useDisplayOrder(runs: CompareRunResult[], shuffle: boolean): number[] {
  return useMemo(() => {
    const order = runs.map((_, index) => index);
    if (!shuffle) return order;
    // Deterministic per-result shuffle (Fisher-Yates seeded off the run count +
    // labels) so the order is stable across re-renders but hides submit order.
    let seed = runs.reduce((acc, run) => acc + run.label.length + 1, runs.length);
    const nextRandom = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(nextRandom() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }, [runs, shuffle]);
}

const ResultsGrid: React.FC<ResultsGridProps> = ({ result, blind, revealed }) => {
  const { t } = useTranslation();
  const hideIdentity = blind && !revealed;
  const order = useDisplayOrder(result.runs, hideIdentity);

  return (
    <div className={styles.grid} data-testid='compare-results-grid'>
      {order.map((runIndex, position) => {
        const run = result.runs[runIndex];
        const alias = t('compare.result.alias', { letter: String.fromCharCode(65 + position) });
        const heading = hideIdentity ? alias : run.label;
        return (
          <section key={`${run.modelRef.providerId}::${run.modelRef.modelId}`} className={styles.card}>
            <header className={styles.cardHeader}>
              <span className={styles.cardTitle} title={heading}>
                {heading}
              </span>
              {run.ok ? (
                <Tag color='green' icon={<Check size={12} />} size='small'>
                  {t('compare.result.ms', { ms: run.ms })}
                </Tag>
              ) : (
                <Tag color='red' icon={<AlertCircle size={12} />} size='small'>
                  {t('compare.result.error')}
                </Tag>
              )}
            </header>
            <div className={styles.cardBody}>
              {run.ok ? (
                <pre className={styles.output}>{run.text || t('compare.result.emptyOutput')}</pre>
              ) : (
                <div className={styles.errorBox}>
                  <AlertCircle size={16} className={styles.errorIcon} />
                  <span>{run.error || t('compare.result.error')}</span>
                </div>
              )}
            </div>
          </section>
        );
      })}
      {result.runs.length === 0 ? <Spin className={styles.gridSpin} /> : null}
    </div>
  );
};

export default ResultsGrid;
