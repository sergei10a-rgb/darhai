/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Select } from '@arco-design/web-react';
import { Telescope } from 'lucide-react';
import type { ResearchCategory, StartResearchParams } from '@/common/types/research';
import styles from '../Research.module.css';

const CATEGORIES: ResearchCategory[] = ['auto', 'general', 'product', 'comparison', 'howto', 'factcheck'];
const ROUND_OPTIONS = [1, 2, 3, 4, 5];

interface ResearchComposerProps {
  running: boolean;
  onStart: (params: StartResearchParams) => void;
}

/**
 * Query + settings composer for a research run. Owns its own draft state and
 * hands a validated {@link StartResearchParams} to the page on submit.
 */
const ResearchComposer: React.FC<ResearchComposerProps> = ({ running, onStart }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ResearchCategory>('auto');
  const [rounds, setRounds] = useState(3);

  const canStart = query.trim().length > 0 && !running;

  const handleStart = (): void => {
    if (!canStart) return;
    onStart({ query: query.trim(), category, rounds });
  };

  return (
    <div className={styles.composer}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('research.query.label')}</span>
        <Input.TextArea
          value={query}
          onChange={setQuery}
          placeholder={t('research.query.placeholder')}
          autoSize={{ minRows: 3, maxRows: 8 }}
          disabled={running}
          data-testid='research-query'
        />
      </label>

      <div className={styles.controlRow}>
        <div className={styles.control}>
          <span className={styles.fieldLabel}>{t('research.settings.category')}</span>
          <Select value={category} onChange={setCategory} disabled={running} data-testid='research-category'>
            {CATEGORIES.map((c) => (
              <Select.Option key={c} value={c}>
                {t(`research.category.${c}`)}
              </Select.Option>
            ))}
          </Select>
        </div>

        <div className={styles.control}>
          <span className={styles.fieldLabel}>{t('research.settings.rounds')}</span>
          <Select value={rounds} onChange={setRounds} disabled={running} data-testid='research-rounds'>
            {ROUND_OPTIONS.map((n) => (
              <Select.Option key={n} value={n}>
                {t('research.settings.roundsCount', { count: n })}
              </Select.Option>
            ))}
          </Select>
        </div>

        <div className={styles.spacer} />

        <Button
          type='primary'
          icon={<Telescope size={16} />}
          loading={running}
          disabled={!canStart}
          onClick={handleStart}
          data-testid='research-start'
        >
          {running ? t('research.running') : t('research.start')}
        </Button>
      </div>
    </div>
  );
};

export default ResearchComposer;
