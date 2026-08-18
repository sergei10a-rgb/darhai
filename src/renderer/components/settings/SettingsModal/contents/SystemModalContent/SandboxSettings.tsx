/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConfigStorage } from '@/common/config/storage';
import { Alert, Message, Radio, Switch } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import useSWR, { mutate } from 'swr';
import PreferenceRow from './PreferenceRow';

type SandboxMode = 'read-only' | 'workspace-write';
type SandboxConfig = { enabled: boolean; mode: SandboxMode };

const SWR_KEY = 'security.hostSandbox';
const DEFAULT_CONFIG: SandboxConfig = { enabled: false, mode: 'read-only' };

/** The OS-level sandbox is a Windows-only ACL restricted-token feature. */
const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

/**
 * Settings card for the opt-in OS-level host-execution sandbox. Toggles the
 * `security.hostSandbox` config and lets the user pick the confined mode. The
 * card is honest about the two hard limits: it is Windows-only, and the Windows
 * ACL backend can only ever enforce PARTIALLY.
 */
const SandboxSettings: React.FC = () => {
  const { t } = useTranslation();
  const { data } = useSWR(SWR_KEY, () => ConfigStorage.get('security.hostSandbox'));
  const config: SandboxConfig = data ?? DEFAULT_CONFIG;

  const persist = async (next: SandboxConfig) => {
    try {
      await ConfigStorage.set('security.hostSandbox', next);
      await mutate(SWR_KEY);
    } catch {
      Message.error(t('common.error'));
    }
  };

  const handleToggle = (enabled: boolean) => {
    void persist({ ...config, enabled });
  };

  const handleModeChange = (mode: SandboxMode) => {
    void persist({ ...config, mode });
  };

  return (
    <div className='px-[12px] md:px-[32px] py-16px bg-[var(--color-bg-2)] border-2 border-solid border-[var(--color-border-2)] rd-12px space-y-12px'>
      <div className='text-14px font-medium text-t-primary mb-8px'>{t('settings.sandbox.title')}</div>

      <PreferenceRow label={t('settings.sandbox.enable')} description={t('settings.sandbox.enableDesc')}>
        <Switch
          checked={config.enabled}
          disabled={!isWindows}
          onChange={handleToggle}
          data-testid='sandbox-enable-switch'
        />
      </PreferenceRow>

      {config.enabled && (
        <div className='space-y-8px'>
          <div className='text-12px text-t-tertiary'>{t('settings.sandbox.mode')}</div>
          <Radio.Group
            type='button'
            value={config.mode}
            onChange={(value) => handleModeChange(value as SandboxMode)}
            disabled={!isWindows}
          >
            <Radio value='read-only'>{t('settings.sandbox.modeReadOnly')}</Radio>
            <Radio value='workspace-write'>{t('settings.sandbox.modeWorkspaceWrite')}</Radio>
          </Radio.Group>
          <div className='text-12px text-t-tertiary'>
            {config.mode === 'read-only'
              ? t('settings.sandbox.modeReadOnlyDesc')
              : t('settings.sandbox.modeWorkspaceWriteDesc')}
          </div>

          {/* Honest enforcement disclosure — Windows ACL is ALWAYS partial. */}
          <Alert type='warning' content={t('settings.sandbox.partialWarning')} className='mt-8px' />
        </div>
      )}

      {!isWindows && <Alert type='info' content={t('settings.sandbox.windowsOnly')} className='mt-8px' />}
    </div>
  );
};

export default SandboxSettings;
