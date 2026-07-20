/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EccSettingsPanel - settings for the bundled ECC agent harness.
 *
 * Shows install status (the harness ships with Дархай and installs itself
 * into ~/.claude on first launch) and hosts the GateGuard toggle. GateGuard
 * defaults to ON; turning it off makes Darhai inject ECC_GATEGUARD=off into
 * claude agent spawns.
 *
 * Mounted at `/settings/ecc`, reachable from the Settings sidebar.
 */

import { Message, Switch, Tag, Typography } from '@arco-design/web-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import SettingsPageWrapper from './components/SettingsPageWrapper';

const EccSettingsPanel: React.FC = () => {
  const { t } = useTranslation();
  const [gateGuardEnabled, setGateGuardEnabled] = useState(true);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [hookGuardEnabled, setHookGuardEnabled] = useState(true);
  const [hookGuardLoading, setHookGuardLoading] = useState(false);

  useEffect(() => {
    let disposed = false;
    void ipcBridge.ecc.getStatus
      .invoke()
      .then((status) => {
        if (disposed || !status) return;
        setGateGuardEnabled(status.gateGuardEnabled === true);
        setInstalled(status.installed === true);
      })
      .catch((err: unknown) => {
        console.error('[EccSettingsPanel] getStatus failed:', err);
      });
    void ipcBridge.hookGuard.getStatus
      .invoke()
      .then((status) => {
        if (disposed || !status) return;
        setHookGuardEnabled(status.enabled === true);
      })
      .catch((err: unknown) => {
        console.error('[EccSettingsPanel] hookGuard.getStatus failed:', err);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const handleHookGuardToggle = useCallback(
    async (next: boolean) => {
      if (hookGuardLoading) return;
      const previous = hookGuardEnabled;
      setHookGuardEnabled(next);
      setHookGuardLoading(true);
      try {
        const result = await ipcBridge.hookGuard.setEnabled.invoke({ enabled: next });
        if (!result?.ok) {
          setHookGuardEnabled(previous);
          Message.error(t('settings.ecc.toggleError', { defaultValue: 'Could not save the setting. Try again.' }));
        }
      } catch (err) {
        setHookGuardEnabled(previous);
        Message.error(
          err instanceof Error
            ? err.message
            : t('settings.ecc.toggleError', { defaultValue: 'Could not save the setting. Try again.' })
        );
      } finally {
        setHookGuardLoading(false);
      }
    },
    [hookGuardLoading, hookGuardEnabled, t]
  );

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (loading) return;
      const previous = gateGuardEnabled;
      setGateGuardEnabled(next);
      setLoading(true);
      try {
        const result = await ipcBridge.ecc.setGateGuard.invoke({ enabled: next });
        if (!result?.ok) {
          setGateGuardEnabled(previous);
          Message.error(t('settings.ecc.toggleError', { defaultValue: 'Could not save the setting. Try again.' }));
        }
      } catch (err) {
        setGateGuardEnabled(previous);
        Message.error(
          err instanceof Error
            ? err.message
            : t('settings.ecc.toggleError', { defaultValue: 'Could not save the setting. Try again.' })
        );
      } finally {
        setLoading(false);
      }
    },
    [loading, gateGuardEnabled, t]
  );

  return (
    <SettingsPageWrapper>
      <div
        className='flex flex-col gap-16px'
        data-testid='ecc-settings-panel'
        role='region'
        aria-label={t('settings.ecc.title', { defaultValue: 'ECC agent harness' })}
      >
        <div className='flex items-center gap-12px'>
          <Typography.Title heading={5} className='!mb-0'>
            {t('settings.ecc.title', { defaultValue: 'ECC agent harness' })}
          </Typography.Title>
          {installed !== null && (
            <Tag color={installed ? 'green' : 'gray'} size='small' data-testid='ecc-settings-status-tag'>
              {installed
                ? t('settings.ecc.installed', { defaultValue: 'Installed' })
                : t('settings.ecc.notInstalled', { defaultValue: 'Not installed yet' })}
            </Tag>
          )}
        </div>

        <Typography.Text type='secondary' className='text-12px'>
          {t('settings.ecc.aboutBody', {
            defaultValue:
              'Professional rules, skills, and reviewer agents for the Claude engine. Ships with Дархай and installs itself automatically on first launch - an existing ECC install is never modified.',
          })}
        </Typography.Text>

        <div className='flex flex-col gap-12px p-16px rd-12px bg-aou-1'>
          <div className='flex items-center justify-between gap-16px'>
            <Typography.Text className='text-14px font-medium'>
              {t('settings.ecc.gateGuardLabel', { defaultValue: 'GateGuard (fact-forcing gate)' })}
            </Typography.Text>
            <Switch
              checked={gateGuardEnabled}
              loading={loading}
              onChange={(value: boolean) => {
                void handleToggle(value);
              }}
              data-testid='ecc-settings-gateguard-switch'
            />
          </div>
          <Typography.Text type='secondary' className='text-12px'>
            {t('settings.ecc.gateGuardDescription', {
              defaultValue:
                'When on, the Claude agent must state its evidence (callers, schemas, your instruction) before the first edit of each file. Stricter output, but slower and its prompts are in English. Applies to newly started agents.',
            })}
          </Typography.Text>
        </div>

        <div className='flex flex-col gap-12px p-16px rd-12px bg-aou-1'>
          <div className='flex items-center justify-between gap-16px'>
            <Typography.Text className='text-14px font-medium'>
              {t('settings.ecc.hookGuardLabel', { defaultValue: 'Dangerous-command guard' })}
            </Typography.Text>
            <Switch
              checked={hookGuardEnabled}
              loading={hookGuardLoading}
              onChange={(value: boolean) => {
                void handleHookGuardToggle(value);
              }}
              data-testid='ecc-settings-hookguard-switch'
            />
          </div>
          <Typography.Text type='secondary' className='text-12px'>
            {t('settings.ecc.hookGuardDescription', {
              defaultValue:
                'When on, Darhai blocks obviously destructive commands (rm -rf /, mkfs, DROP TABLE, ...) before any agent tool runs, and warns on writes that look like they contain a secret. Applies to all built-in agents.',
            })}
          </Typography.Text>
        </div>
      </div>
    </SettingsPageWrapper>
  );
};

export default EccSettingsPanel;
