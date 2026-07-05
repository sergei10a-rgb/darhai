/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Tag } from '@arco-design/web-react';
import { Cpu, HardDrive, MemoryStick, MonitorCog } from 'lucide-react';
import type { HwfitHardware } from '@/common/types/hwfit';
import styles from './ModelAdvisor.module.css';

type HardwarePanelProps = {
  hardware: HwfitHardware | undefined;
  loading: boolean;
  simulated: boolean;
};

const StatCell: React.FC<{ icon: React.ReactNode; label: string; value: string; muted?: boolean }> = ({
  icon,
  label,
  value,
  muted,
}) => (
  <div className={styles.statCell}>
    <span className={styles.statIcon}>{icon}</span>
    <div className={styles.statBody}>
      <span className={styles.statLabel}>{label}</span>
      <span className={muted ? styles.statValueMuted : styles.statValue}>{value}</span>
    </div>
  </div>
);

const HardwarePanel: React.FC<HardwarePanelProps> = ({ hardware, loading, simulated }) => {
  const { t } = useTranslation();

  if (!hardware) {
    return (
      <Card className={styles.hwCard}>
        <span className={styles.statLabel}>
          {loading ? t('modelAdvisor.scanning') : t('modelAdvisor.hardware.noGpu')}
        </span>
      </Card>
    );
  }

  const gpuValue = hardware.hasGpu
    ? (hardware.gpuName ?? t('modelAdvisor.hardware.gpu'))
    : hardware.gpuError
      ? t('modelAdvisor.hardware.gpuError')
      : t('modelAdvisor.hardware.noGpu');

  const vramValue =
    hardware.hasGpu && hardware.gpuVramGb ? `${hardware.gpuVramGb} GB` : t('modelAdvisor.hardware.cpuOnly');

  return (
    <Card className={styles.hwCard}>
      <div className={styles.hwHead}>
        <span className={styles.hwTitle}>{t('modelAdvisor.hardware.title')}</span>
        {simulated ? <Tag color='arcoblue'>{t('modelAdvisor.simulate.label')}</Tag> : null}
        {hardware.unifiedMemory ? <Tag color='purple'>{t('modelAdvisor.hardware.unified')}</Tag> : null}
      </div>
      <div className={styles.hwGrid}>
        <StatCell
          icon={<MonitorCog size={18} />}
          label={t('modelAdvisor.hardware.gpu')}
          value={gpuValue}
          muted={!hardware.hasGpu}
        />
        <StatCell
          icon={<HardDrive size={18} />}
          label={t('modelAdvisor.hardware.vram')}
          value={vramValue}
          muted={!hardware.hasGpu}
        />
        <StatCell
          icon={<MemoryStick size={18} />}
          label={t('modelAdvisor.hardware.ram')}
          value={`${hardware.totalRamGb} GB`}
        />
        <StatCell
          icon={<Cpu size={18} />}
          label={t('modelAdvisor.hardware.cpu')}
          value={t('modelAdvisor.hardware.cores', { count: hardware.cpuCores })}
        />
      </div>
    </Card>
  );
};

export default HardwarePanel;
