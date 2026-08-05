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
import { useSWRConfig } from 'swr';
import { ipcBridge } from '@/common';
import { MAX_PLAUSIBLE_MNT_PER_USD, MIN_PLAUSIBLE_MNT_PER_USD } from '@process/services/cost/fxRate';
import { MNT_RATE_KEY, useMntRate } from '@renderer/hooks/cost/useMntRate';
import styles from './Cost.module.css';

/**
 * `YYYY-MM-DD`, not the host locale's default.
 *
 * `toLocaleDateString()` with no locale follows the operating system, which on a
 * Mongolian user's machine still printed `8/5/2026` - a US month-first date
 * sitting inside otherwise fully-Mongolian copy, and ambiguous with 5 August in
 * every other convention. The ISO form is unambiguous and reads naturally here.
 */
export const formatRateDate = (epochMs: number): string => {
  const d = new Date(epochMs);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const MntRatePanel: React.FC = () => {
  const { t } = useTranslation();
  const { rate } = useMntRate();
  const { mutate } = useSWRConfig();
  const [auto, setAuto] = useState(true);
  const [manual, setManual] = useState<number | undefined>(undefined);

  useEffect(() => {
    void ipcBridge.cost.mntRateSettings.invoke().then((settings) => {
      setAuto(settings.auto);
      setManual(settings.manualMntPerUsd);
    });
  }, []);

  const save = useCallback(
    async (nextAuto: boolean, nextManual: number | undefined) => {
      setAuto(nextAuto);
      setManual(nextManual);
      await ipcBridge.cost.setMntRateSettings.invoke({ auto: nextAuto, manualMntPerUsd: nextManual ?? null });
      // Invalidate the SHARED cache entry, not just call the bridge again. Every
      // spend surface reads this one key, so this re-converts all of them at once.
      // Calling the bridge directly would fetch a rate SWR never sees, leaving the
      // figures on screen stale until the page remounted - a change that appears
      // to do nothing.
      await mutate(MNT_RATE_KEY);
    },
    [mutate]
  );

  const rateLine = rate
    ? t('missionControl.cost.fx.current', {
        rate: Math.round(rate.mntPerUsd).toLocaleString('en-US'),
        source:
          rate.source === 'manual'
            ? t('missionControl.cost.fx.sourceManual')
            : t('missionControl.cost.fx.sourceFetched', {
                date: rate.asOf ? formatRateDate(rate.asOf) : '',
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
