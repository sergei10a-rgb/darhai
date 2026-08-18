/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The cost circuit-breaker settings: an on/off switch, a limit amount, its
 * currency (tögrög or USD) and its window (this session or the calendar day).
 *
 * It sits on the cost page beside the exchange-rate panel because that is
 * where the user is already thinking about spend. Reads/writes go straight
 * through ConfigStorage ('cost.circuitBreaker') - the main process re-reads
 * the key on every recorded turn, so a change here applies to the very next
 * turn without any extra IPC verb.
 */

import { InputNumber, Select, Switch } from '@arco-design/web-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigStorage } from '@/common/config/storage';
import styles from './Cost.module.css';

type BreakerDraft = {
  enabled: boolean;
  limitAmount: number | undefined;
  currency: 'MNT' | 'USD';
  period: 'session' | 'day';
};

const DEFAULT_DRAFT: BreakerDraft = { enabled: false, limitAmount: undefined, currency: 'MNT', period: 'day' };

export const CircuitBreakerPanel: React.FC = () => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<BreakerDraft>(DEFAULT_DRAFT);

  useEffect(() => {
    void ConfigStorage.get('cost.circuitBreaker').then((stored) => {
      if (!stored) return;
      setDraft({
        enabled: stored.enabled === true,
        limitAmount: typeof stored.limitAmount === 'number' && stored.limitAmount > 0 ? stored.limitAmount : undefined,
        currency: stored.currency === 'USD' ? 'USD' : 'MNT',
        period: stored.period === 'session' ? 'session' : 'day',
      });
    });
  }, []);

  const save = useCallback(async (next: BreakerDraft) => {
    setDraft(next);
    await ConfigStorage.set('cost.circuitBreaker', {
      // An enabled breaker with no usable limit is normalized to disabled by
      // the main process; mirror that here so the switch reflects reality.
      enabled: next.enabled && typeof next.limitAmount === 'number' && next.limitAmount > 0,
      limitAmount: typeof next.limitAmount === 'number' && next.limitAmount > 0 ? next.limitAmount : 0,
      currency: next.currency,
      period: next.period,
    });
  }, []);

  return (
    <div className={styles.panel} data-testid='circuit-breaker-panel'>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>{t('missionControl.cost.circuitBreaker.title')}</span>
      </div>
      <div className={styles.panelHint}>{t('missionControl.cost.circuitBreaker.hint')}</div>
      {/* Honest about the mechanism (M4): the cap is checked AFTER a turn's
          cost is recorded, so an in-flight turn finishes before the stop. */}
      <div className={styles.panelHint}>{t('missionControl.cost.circuitBreaker.reactiveNote')}</div>
      <div className='flex items-center gap-16px mt-8px flex-wrap'>
        <label className='flex items-center gap-8px'>
          <Switch
            size='small'
            checked={draft.enabled}
            onChange={(checked) => void save({ ...draft, enabled: checked })}
          />
          <span className='text-xs'>{t('missionControl.cost.circuitBreaker.enable')}</span>
        </label>
        <label className='flex items-center gap-8px'>
          <span className='text-xs'>{t('missionControl.cost.circuitBreaker.limit')}</span>
          <InputNumber
            size='small'
            style={{ width: 140 }}
            min={0}
            value={draft.limitAmount}
            placeholder={draft.currency === 'MNT' ? '100000' : '30'}
            onChange={(value) => setDraft({ ...draft, limitAmount: typeof value === 'number' ? value : undefined })}
            onBlur={() => void save(draft)}
          />
        </label>
        <Select
          size='small'
          style={{ width: 90 }}
          value={draft.currency}
          onChange={(value) => void save({ ...draft, currency: value as BreakerDraft['currency'] })}
          options={[
            { label: t('missionControl.cost.circuitBreaker.currencyMnt'), value: 'MNT' },
            { label: t('missionControl.cost.circuitBreaker.currencyUsd'), value: 'USD' },
          ]}
        />
        <Select
          size='small'
          style={{ width: 150 }}
          value={draft.period}
          onChange={(value) => void save({ ...draft, period: value as BreakerDraft['period'] })}
          options={[
            { label: t('missionControl.cost.circuitBreaker.periodDay'), value: 'day' },
            { label: t('missionControl.cost.circuitBreaker.periodSession'), value: 'session' },
          ]}
        />
      </div>
    </div>
  );
};

export default CircuitBreakerPanel;
