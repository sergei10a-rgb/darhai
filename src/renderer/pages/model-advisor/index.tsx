/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu } from 'lucide-react';
import PageShell from '@/renderer/components/layout/PageShell';
import { useModelAdvisor } from './useModelAdvisor';
import { useCookbookServe } from './useCookbookServe';
import { useLlamaRuntime } from './useLlamaRuntime';
import HardwarePanel from './HardwarePanel';
import AdvisorToolbar from './AdvisorToolbar';
import ModelTable from './ModelTable';
import { GPU_PRESETS, buildOverride } from './gpuPresets';
import styles from './ModelAdvisor.module.css';

const ModelAdvisorPage: React.FC = () => {
  const { t } = useTranslation();
  const {
    hardware,
    hardwareLoading,
    catalogSize,
    results,
    totalResults,
    rankLoading,
    useCase,
    setUseCase,
    search,
    setSearch,
    fitOnly,
    setFitOnly,
    override,
    setOverride,
    rescan,
  } = useModelAdvisor();
  const cookbook = useCookbookServe();
  // One runtime per machine, so it is subscribed once here rather than per row.
  const runtime = useLlamaRuntime();

  const [gpuOnly, setGpuOnly] = useState(true);
  const [rescanning, setRescanning] = useState(false);

  const handleRescan = async (): Promise<void> => {
    setRescanning(true);
    try {
      await rescan();
    } finally {
      setRescanning(false);
    }
  };

  // Rebuild the override when the gpuOnly toggle flips so it takes effect
  // without re-picking the GPU. We reuse the currently-selected preset by
  // matching the override's GPU name back to the preset list.
  const handleGpuOnlyChange = (value: boolean): void => {
    setGpuOnly(value);
    if (override && hardware) {
      const preset = GPU_PRESETS.find((p) => p.name === override.gpuName);
      if (preset) setOverride(buildOverride(preset, hardware, value));
    }
  };

  const shownHardware = override ?? hardware;
  const hasResults = results.length > 0;

  return (
    <PageShell
      title={t('modelAdvisor.pageTitle')}
      icon={<Cpu size={20} />}
      subtitle={t('modelAdvisor.description')}
      countLabel={t('modelAdvisor.footer.count', { shown: results.length, total: catalogSize })}
      width='full'
    >
      <HardwarePanel hardware={shownHardware} loading={hardwareLoading} simulated={Boolean(override)} />

      <AdvisorToolbar
        useCase={useCase}
        onUseCaseChange={setUseCase}
        search={search}
        onSearchChange={setSearch}
        fitOnly={fitOnly}
        onFitOnlyChange={setFitOnly}
        detectedHardware={hardware}
        overrideActive={Boolean(override)}
        onOverrideChange={setOverride}
        gpuOnly={gpuOnly}
        onGpuOnlyChange={handleGpuOnlyChange}
        onRescan={handleRescan}
        rescanning={rescanning}
      />

      {!hasResults && !rankLoading ? (
        <div className={styles.empty}>
          <Cpu size={40} className={styles.emptyIcon} />
          <span className={styles.emptyTitle}>{t('modelAdvisor.empty.title')}</span>
          <span className={styles.emptyHint}>{t('modelAdvisor.empty.hint')}</span>
        </div>
      ) : (
        <ModelTable results={results} loading={rankLoading} cookbook={cookbook} runtime={runtime} />
      )}

      <div className={styles.footer}>
        {t('modelAdvisor.footer.count', { shown: results.length, total: totalResults })}
      </div>
    </PageShell>
  );
};

export default ModelAdvisorPage;
