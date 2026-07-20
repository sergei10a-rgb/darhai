/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Tag, Tooltip } from '@arco-design/web-react';
import type { ColumnProps } from '@arco-design/web-react/es/Table';
import type { HwfitFitLevel, HwfitResult } from '@/common/types/hwfit';
import CookbookServeControls from './CookbookServeControls';
import type { CookbookController } from './useCookbookServe';
import styles from './ModelAdvisor.module.css';

type ModelTableProps = {
  results: HwfitResult[];
  loading: boolean;
  cookbook: CookbookController;
};

/** Arco Tag color per fit level (semantic, not decorative). */
const FIT_COLOR: Record<HwfitFitLevel, string> = {
  perfect: 'green',
  good: 'cyan',
  marginal: 'orange',
  too_tight: 'red',
};

const ModelTable: React.FC<ModelTableProps> = ({ results, loading, cookbook }) => {
  const { t } = useTranslation();

  const columns = useMemo<ColumnProps<HwfitResult>[]>(
    () => [
      {
        title: t('modelAdvisor.table.model'),
        dataIndex: 'name',
        render: (_: unknown, row: HwfitResult) => {
          const [org, ...rest] = row.name.split('/');
          const short = rest.length ? rest.join('/') : org;
          return (
            <div className={styles.modelCell}>
              <span className={styles.modelName}>{short}</span>
              <span className={styles.modelProvider}>{row.provider}</span>
            </div>
          );
        },
      },
      {
        title: t('modelAdvisor.table.params'),
        dataIndex: 'paramsB',
        align: 'right',
        width: 110,
        sorter: (a: HwfitResult, b: HwfitResult) => a.paramsB - b.paramsB,
        render: (_: unknown, row: HwfitResult) => (
          <span>
            {row.paramsB}B
            {row.isMoe ? (
              <Tag size='small' color='purple' className={styles.moeTag}>
                {t('modelAdvisor.table.moe')}
              </Tag>
            ) : null}
          </span>
        ),
      },
      {
        title: t('modelAdvisor.table.quant'),
        dataIndex: 'quant',
        width: 110,
        render: (quant: string) => <span className={styles.mono}>{quant}</span>,
      },
      {
        title: t('modelAdvisor.table.vram'),
        dataIndex: 'requiredGb',
        align: 'right',
        width: 100,
        sorter: (a: HwfitResult, b: HwfitResult) => a.requiredGb - b.requiredGb,
        render: (gb: number) => <span>{gb} GB</span>,
      },
      {
        title: t('modelAdvisor.table.speed'),
        dataIndex: 'speedTps',
        align: 'right',
        width: 120,
        sorter: (a: HwfitResult, b: HwfitResult) => a.speedTps - b.speedTps,
        render: (tps: number) =>
          tps > 0 ? <span>{t('modelAdvisor.table.tps', { value: tps })}</span> : <span>-</span>,
      },
      {
        title: t('modelAdvisor.table.fit'),
        dataIndex: 'fitLevel',
        width: 130,
        render: (level: HwfitFitLevel, row: HwfitResult) => (
          <Tooltip content={t(`modelAdvisor.runMode.${row.runMode}`)}>
            <Tag color={FIT_COLOR[level]}>{t(`modelAdvisor.fit.${level}`)}</Tag>
          </Tooltip>
        ),
      },
      {
        title: t('modelAdvisor.table.score'),
        dataIndex: 'score',
        align: 'right',
        width: 90,
        defaultSortOrder: 'descend',
        sorter: (a: HwfitResult, b: HwfitResult) => a.score - b.score,
        render: (score: number) => <span className={styles.scoreValue}>{score}</span>,
      },
      {
        title: t('modelAdvisor.cookbook.column'),
        dataIndex: 'ggufSources',
        width: 260,
        render: (_: unknown, row: HwfitResult) =>
          row.ggufSources.length > 0 ? <CookbookServeControls modelId={row.name} controller={cookbook} /> : null,
      },
    ],
    [t, cookbook]
  );

  return (
    <Table<HwfitResult>
      loading={loading}
      columns={columns}
      data={results}
      rowKey='name'
      pagination={{ pageSize: 20, sizeCanChange: false, showTotal: true }}
      border={{ wrapper: true, cell: false }}
      stripe
      className={styles.table}
    />
  );
};

export default ModelTable;
