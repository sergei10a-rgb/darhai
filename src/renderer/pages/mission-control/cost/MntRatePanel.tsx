/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The exchange rate every spend figure on this page is converted with.
 *
 * It sits on the cost page rather than in a settings screen because that is
 * where the number matters: seeing "$12.40 · 44,392₮" raises exactly one
 * question - at what rate? - and the answer should be one glance away, along
 * with the means to change it.
 *
 * The rate is always shown with where it came from. A conversion the user cannot
 * account for is one they cannot check against their own bank statement.
 */

import { InputNumber, Switch, Tooltip } from '@arco-design/web-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { MAX_PLAUSIBLE_MNT_PER_USD, MIN_PLAUSIBLE_MNT_PER_USD } from '@process/services/cost/fxRate';
import { useMntRate } from '@renderer/hooks/cost/useMntRate';
import styles from './Cost.module.css';

export const MntRatePanel: React.FC = () => {
  const { t } = useTranslation();
  const { rate } = useMntRate();
  const [auto, setAuto] = useState(true);
  const [manual, setManual] = useState<number | undefined>(undefined);

  useEffect(() => {
    void ipcBridge.cost.mntRateSettings.invoke().then((settings) => {
      setAuto(settings.auto);
      setManual(settings.manualMntPerUsd);
    });
  }, []);

  const save = useCallback(async (nextAuto: boolean, nextManual: number | undefined) => {
    setAuto(nextAuto);
    setManual(nextManual);
    await ipcBridge.cost.setMntRateSettings.invoke({ auto: nextAuto, manualMntPerUsd: nextManual ?? null });
    // Every spend surface on the page reads the same SWR key, so re-fetching it
    // here re-converts all of them at once rather than leaving the page showing
    // two different rates.
    await ipcBridge.cost.mntRate.invoke();
  }, []);

  const rateLine = rate
    ? t('missionControl.cost.fx.current', {
        rate: Math.round(rate.mntPerUsd).toLocaleString('en-US'),
        source:
          rate.source === 'manual'
            ? t('missionControl.cost.fx.sourceManual')
            : t('missionControl.cost.fx.sourceFetched', {
                date: rate.asOf ? new Date(rate.asOf).toLocaleDateString() : '',
              }),
      })
    : t('missionControl.cost.fx.unknown');

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>{t('missionControl.cost.fx.title')}</span>
      </div>
      <div className={styles.panelHint}>{rateLine}</div>
      <div className='flex items-center gap-16px mt-8px flex-wrap'>
        <label className='flex items-center gap-8px'>
          <Switch size='small' checked={auto} onChange={(checked) => void save(checked, manual)} />
          <span className='text-xs'>{t('missionControl.cost.fx.auto')}</span>
        </label>
        <Tooltip content={t('missionControl.cost.fx.manualHint')}>
          <label className='flex items-center gap-8px'>
            <span className='text-xs'>{t('missionControl.cost.fx.manual')}</span>
            <InputNumber
              size='small'
              style={{ width: 120 }}
              min={MIN_PLAUSIBLE_MNT_PER_USD}
              max={MAX_PLAUSIBLE_MNT_PER_USD}
              value={manual}
              placeholder='3580'
              onChange={(value) => setManual(typeof value === 'number' ? value : undefined)}
              onBlur={() => void save(auto, manual)}
            />
          </label>
        </Tooltip>
      </div>
    </div>
  );
};

export default MntRatePanel;
