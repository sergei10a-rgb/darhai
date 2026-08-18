/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DoctorSettingsPanel - the diagnostics page (Settings -> Оношилгоо).
 *
 * One button runs the main-process Doctor battery (`doctor.run`) over Darhai's
 * subsystems - bun runtime, builtin MCP servers, llama.cpp receipt, Mongolian
 * voice components, ffmpeg, OmniRoute, memory index, disk space - and the
 * results render as a grouped, color-coded list with per-check detail and a
 * remediation line on anything that is not a pass. Check details arrive
 * already translated (the main process resolves them with its own i18n);
 * titles are translated here from `titleKey`.
 *
 * Mounted at `/settings/doctor`, reachable from the Settings sidebar.
 */

import { Button, Empty, Spin, Tag, Typography } from '@arco-design/web-react';
import { RefreshCw } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { DoctorCategory, DoctorCheckResult, DoctorReport, DoctorStatus } from '@process/doctor/types';
import SettingsPageWrapper from './components/SettingsPageWrapper';

const STATUS_COLOR: Record<DoctorStatus, string> = { pass: 'green', warn: 'orange', fail: 'red' };

const CATEGORY_ORDER: DoctorCategory[] = ['runtime', 'services', 'models', 'system'];

const ResultRow: React.FC<{ result: DoctorCheckResult }> = ({ result }) => {
  const { t } = useTranslation();
  return (
    <div className='flex flex-col gap-4px p-12px rd-8px bg-aou-1' data-testid={`doctor-result-${result.id}`}>
      <div className='flex items-center gap-8px'>
        <Tag color={STATUS_COLOR[result.status]} size='small' data-testid={`doctor-status-${result.id}`}>
          {t(`settings.doctor.status.${result.status}`)}
        </Tag>
        <Typography.Text className='text-13px font-medium'>{t(result.titleKey)}</Typography.Text>
      </div>
      <Typography.Text type='secondary' className='text-12px'>
        {result.detail}
      </Typography.Text>
      {result.remediation ? (
        <Typography.Text className='text-12px' data-testid={`doctor-remediation-${result.id}`}>
          {t('settings.doctor.remediationLabel')} {result.remediation}
        </Typography.Text>
      ) : null}
    </div>
  );
};

const DoctorSettingsPanel: React.FC = () => {
  const { t } = useTranslation();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const next = await ipcBridge.doctor.run.invoke();
      setReport(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [running]);

  const grouped = useMemo(() => {
    if (!report) return [];
    return CATEGORY_ORDER.map((category) => ({
      category,
      results: report.results.filter((result) => result.category === category),
    })).filter((group) => group.results.length > 0);
  }, [report]);

  return (
    <SettingsPageWrapper>
      <div
        className='flex flex-col gap-16px'
        data-testid='doctor-settings-panel'
        role='region'
        aria-label={t('settings.doctor.title')}
      >
        <div className='flex items-center justify-between gap-12px'>
          <Typography.Title heading={5} className='!mb-0'>
            {t('settings.doctor.title')}
          </Typography.Title>
          <Button
            type='primary'
            size='small'
            icon={<RefreshCw size={14} />}
            loading={running}
            onClick={() => void run()}
            data-testid='doctor-run-button'
          >
            {running ? t('settings.doctor.running') : t('settings.doctor.run')}
          </Button>
        </div>

        <Typography.Text type='secondary' className='text-12px'>
          {t('settings.doctor.subtitle')}
        </Typography.Text>

        {error ? (
          <Typography.Text type='error' className='text-12px' data-testid='doctor-error'>
            {t('settings.doctor.runError', { error })}
          </Typography.Text>
        ) : null}

        {running && !report ? (
          <div className='flex justify-center p-24px'>
            <Spin />
          </div>
        ) : null}

        {!running && !report && !error ? <Empty description={t('settings.doctor.empty')} /> : null}

        {report ? (
          <>
            <div className='flex items-center gap-8px' data-testid='doctor-overall'>
              <Tag color={STATUS_COLOR[report.overall]} size='small'>
                {t(`settings.doctor.overall.${report.overall}`)}
              </Tag>
              <Typography.Text type='secondary' className='text-12px'>
                {t('settings.doctor.counts', {
                  pass: report.counts.pass,
                  warn: report.counts.warn,
                  fail: report.counts.fail,
                })}
              </Typography.Text>
            </div>
            {grouped.map((group) => (
              <div key={group.category} className='flex flex-col gap-8px'>
                <Typography.Text className='text-12px font-medium'>
                  {t(`settings.doctor.category.${group.category}`)}
                </Typography.Text>
                {group.results.map((result) => (
                  <ResultRow key={result.id} result={result} />
                ))}
              </div>
            ))}
          </>
        ) : null}
      </div>
    </SettingsPageWrapper>
  );
};

export default DoctorSettingsPanel;
