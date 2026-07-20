/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Select, Switch } from '@arco-design/web-react';
import { Columns3, Eye, EyeOff, Play } from 'lucide-react';
import PageShell from '@/renderer/components/layout/PageShell';
import { useCompare, modelOptionKey } from './useCompare';
import ResultsGrid from './ResultsGrid';
import styles from './Compare.module.css';

const MAX_MODELS = 6;

const ComparePage: React.FC = () => {
  const { t } = useTranslation();
  const {
    models,
    modelsLoading,
    prompt,
    setPrompt,
    selectedKeys,
    setSelectedKeys,
    blind,
    setBlind,
    running,
    result,
    canRun,
    run,
  } = useCompare();

  // Reveal is page-local: a new run resets it so blind stays blind until asked.
  const [revealed, setRevealed] = useState(false);

  const handleRun = async (): Promise<void> => {
    setRevealed(false);
    await run();
  };

  const atModelLimit = selectedKeys.length >= MAX_MODELS;

  return (
    <PageShell
      title={t('compare.pageTitle')}
      icon={<Columns3 size={20} />}
      subtitle={t('compare.description')}
      countLabel={t('compare.footer.count', { count: models.length })}
      width='full'
      testId='compare-page'
    >
      <div className={styles.controls}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('compare.prompt.label')}</span>
          <Input.TextArea
            value={prompt}
            onChange={setPrompt}
            placeholder={t('compare.prompt.placeholder')}
            autoSize={{ minRows: 3, maxRows: 10 }}
            data-testid='compare-prompt'
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('compare.models.label')}</span>
          <Select
            mode='multiple'
            value={selectedKeys}
            onChange={setSelectedKeys}
            placeholder={t('compare.models.placeholder')}
            loading={modelsLoading}
            allowClear
            showSearch
            filterOption={(input, option) => {
              const children = (option as { props?: { children?: unknown } } | null)?.props?.children;
              return String(children).toLowerCase().includes(input.toLowerCase());
            }}
            maxTagCount={MAX_MODELS}
            data-testid='compare-model-select'
          >
            {models.map((option) => {
              const key = modelOptionKey(option);
              return (
                <Select.Option key={key} value={key} disabled={atModelLimit && !selectedKeys.includes(key)}>
                  {option.label} · {option.providerLabel}
                </Select.Option>
              );
            })}
          </Select>
          {models.length === 0 && !modelsLoading ? (
            <span className={styles.fieldHint}>{t('compare.models.empty')}</span>
          ) : null}
        </label>

        <div className={styles.actionRow}>
          <label className={styles.blindToggle}>
            <Switch checked={blind} onChange={setBlind} data-testid='compare-blind-switch' />
            <span className={styles.blindLabel}>{t('compare.blind.label')}</span>
            <span className={styles.fieldHint}>{t('compare.blind.hint')}</span>
          </label>

          <div className={styles.actionButtons}>
            {result && blind ? (
              <Button
                icon={revealed ? <EyeOff size={16} /> : <Eye size={16} />}
                onClick={() => setRevealed((prev) => !prev)}
                data-testid='compare-reveal'
              >
                {revealed ? t('compare.hide') : t('compare.reveal')}
              </Button>
            ) : null}
            <Button
              type='primary'
              icon={<Play size={16} />}
              loading={running}
              disabled={!canRun}
              onClick={handleRun}
              data-testid='compare-run'
            >
              {running ? t('compare.running') : t('compare.run')}
            </Button>
          </div>
        </div>
      </div>

      {result?.noUsableModel ? (
        <div className={styles.notice} data-testid='compare-no-usable-model'>
          {t('compare.noUsableModel')}
        </div>
      ) : null}

      {result && !result.noUsableModel ? <ResultsGrid result={result} blind={blind} revealed={revealed} /> : null}

      {!result ? (
        <div className={styles.empty} data-testid='compare-empty'>
          <Columns3 size={40} className={styles.emptyIcon} />
          <span className={styles.emptyTitle}>{t('compare.empty.title')}</span>
          <span className={styles.emptyHint}>{t('compare.empty.hint')}</span>
        </div>
      ) : null}
    </PageShell>
  );
};

export default ComparePage;
