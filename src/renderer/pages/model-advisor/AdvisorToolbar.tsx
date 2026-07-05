/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Select, Switch } from '@arco-design/web-react';
import { RefreshCw } from 'lucide-react';
import type { HwfitHardware, HwfitUseCase } from '@/common/types/hwfit';
import { GPU_PRESETS, buildOverride } from './gpuPresets';
import styles from './ModelAdvisor.module.css';

const USE_CASES: readonly HwfitUseCase[] = [
  'general',
  'coding',
  'reasoning',
  'chat',
  'multimodal',
  'embedding',
  'tts',
  'stt',
];

type AdvisorToolbarProps = {
  useCase: HwfitUseCase;
  onUseCaseChange: (uc: HwfitUseCase) => void;
  search: string;
  onSearchChange: (s: string) => void;
  fitOnly: boolean;
  onFitOnlyChange: (v: boolean) => void;
  detectedHardware: HwfitHardware | undefined;
  overrideActive: boolean;
  onOverrideChange: (override: HwfitHardware | null) => void;
  gpuOnly: boolean;
  onGpuOnlyChange: (v: boolean) => void;
  onRescan: () => void;
  rescanning: boolean;
};

const AdvisorToolbar: React.FC<AdvisorToolbarProps> = ({
  useCase,
  onUseCaseChange,
  search,
  onSearchChange,
  fitOnly,
  onFitOnlyChange,
  detectedHardware,
  overrideActive,
  onOverrideChange,
  gpuOnly,
  onGpuOnlyChange,
  onRescan,
  rescanning,
}) => {
  const { t } = useTranslation();

  const handleSimulateChange = (presetId: string): void => {
    if (presetId === 'auto' || !detectedHardware) {
      onOverrideChange(null);
      return;
    }
    const preset = GPU_PRESETS.find((p) => p.id === presetId);
    if (!preset) {
      onOverrideChange(null);
      return;
    }
    onOverrideChange(buildOverride(preset, detectedHardware, gpuOnly));
  };

  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarRow}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('modelAdvisor.useCase.label')}</span>
          <Select value={useCase} onChange={(v) => onUseCaseChange(v as HwfitUseCase)} className={styles.select}>
            {USE_CASES.map((uc) => (
              <Select.Option key={uc} value={uc}>
                {t(`modelAdvisor.useCase.${uc}`)}
              </Select.Option>
            ))}
          </Select>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('modelAdvisor.simulate.label')}</span>
          <Select
            value={overrideActive ? undefined : 'auto'}
            placeholder={t('modelAdvisor.simulate.label')}
            onChange={handleSimulateChange}
            className={styles.select}
          >
            <Select.Option value='auto'>{t('modelAdvisor.simulate.detected')}</Select.Option>
            {GPU_PRESETS.map((p) => (
              <Select.Option key={p.id} value={p.id}>
                {p.label}
              </Select.Option>
            ))}
          </Select>
        </label>

        <Input.Search
          allowClear
          value={search}
          onChange={onSearchChange}
          placeholder={t('modelAdvisor.search.placeholder')}
          className={styles.searchInput}
        />

        <Button icon={<RefreshCw size={14} />} loading={rescanning} onClick={onRescan}>
          {t('modelAdvisor.rescan')}
        </Button>
      </div>

      <div className={styles.toolbarRow}>
        <label className={styles.switchField}>
          <Switch size='small' checked={fitOnly} onChange={onFitOnlyChange} />
          <span className={styles.fieldLabel}>{t('modelAdvisor.fitOnly')}</span>
        </label>
        {overrideActive ? (
          <label className={styles.switchField}>
            <Switch size='small' checked={gpuOnly} onChange={onGpuOnlyChange} />
            <span className={styles.fieldLabel}>{t('modelAdvisor.simulate.gpuOnly')}</span>
          </label>
        ) : null}
      </div>
    </div>
  );
};

export default AdvisorToolbar;
