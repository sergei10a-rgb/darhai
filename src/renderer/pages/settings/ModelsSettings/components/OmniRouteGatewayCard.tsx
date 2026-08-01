/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OmniRouteGatewayCard - the opt-in card for a USER-RUN OmniRoute gateway.
 * Hosted on the Models & Providers settings page.
 *
 * Owner conditions the card embodies:
 *  1. Honest Mongolian disclosure, default OFF - benefits AND risks are always
 *     visible above the switch; the toggle starts disabled and only the user
 *     flips it.
 *  2. Visible marking - the title carries the relay marking; the registered
 *     provider name repeats it in every model picker.
 *  3. Explicit selection only - enabling never makes the relay a default; the
 *     user picks it per conversation.
 *
 * C2 (one-click auto-install + run): the primary action installs + runs the
 * user's OmniRoute in the background and opens OmniRoute's OWN dashboard. The
 * LIABILITY BOUNDARY holds: Darhai installs/runs/opens only - the USER connects
 * a free provider themselves in OmniRoute's dashboard. The manual baseUrl/apiKey
 * fields remain as the advanced / bring-your-own path below the one-click action.
 */

import { Button, Input, Message, Switch, Tag, Typography } from '@arco-design/web-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { OmnirouteGatewayTestResult, OmnirouteRuntimeStatus } from '@/common/types/omnirouteGateway';
import { OMNIROUTE_GATEWAY_DEFAULT_BASE_URL } from '@/common/types/omnirouteGateway';

const NODEJS_DOWNLOAD_URL = 'https://nodejs.org';

/** Map a service error token onto a localized message. */
function errorText(t: ReturnType<typeof useTranslation>['t'], token: string): string {
  if (token === 'invalid-base-url') return t('settings.omnirouteGateway.invalidUrl');
  return t('settings.omnirouteGateway.testFail', { error: token });
}

/** Status-pill descriptor (text + Arco color) for a runtime state. */
function runtimePill(
  t: ReturnType<typeof useTranslation>['t'],
  status: OmnirouteRuntimeStatus | null
): { text: string; color: string } | null {
  if (!status) return null;
  switch (status.state) {
    case 'installing':
      return { text: t('settings.omnirouteGateway.autoInstall.installing'), color: 'arcoblue' };
    case 'installed':
      return { text: t('settings.omnirouteGateway.autoInstall.installed'), color: 'gray' };
    case 'starting':
      return { text: t('settings.omnirouteGateway.autoInstall.starting'), color: 'arcoblue' };
    case 'running':
      return { text: t('settings.omnirouteGateway.autoInstall.running'), color: 'green' };
    case 'stopped':
      return { text: t('settings.omnirouteGateway.autoInstall.stopped'), color: 'gray' };
    case 'error':
      return { text: t('settings.omnirouteGateway.autoInstall.errorLabel'), color: 'red' };
    default:
      return null;
  }
}

const OmniRouteGatewayCard: React.FC = () => {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState(OMNIROUTE_GATEWAY_DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState('');
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<OmnirouteGatewayTestResult | null>(null);

  // C2 one-click runtime state.
  const [runtime, setRuntime] = useState<OmnirouteRuntimeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [progressLine, setProgressLine] = useState('');

  useEffect(() => {
    let disposed = false;
    void ipcBridge.omnirouteGateway.getConfig
      .invoke()
      .then((view) => {
        if (disposed || !view) return;
        setEnabled(view.enabled === true);
        setBaseUrl(view.baseUrl || OMNIROUTE_GATEWAY_DEFAULT_BASE_URL);
        setHasStoredKey(view.hasApiKey === true);
      })
      .catch((err: unknown) => {
        console.error('[OmniRouteGatewayCard] getConfig failed:', err);
      });
    void ipcBridge.omnirouteGateway.runtimeStatus
      .invoke()
      .then((status) => {
        if (!disposed && status) setRuntime(status);
      })
      .catch(() => {
        /* runtime status is best-effort; the card still works without it */
      });
    return () => {
      disposed = true;
    };
  }, []);

  // Live runtime-status + install-progress from the main process.
  useEffect(() => {
    const offStatus = ipcBridge.omnirouteGateway.onRuntimeStatus.on((status: OmnirouteRuntimeStatus) => {
      setRuntime(status);
      // A running server does NOT mean the relay is on: the switch mirrors the
      // persisted opt-in only, so it can never show a consent nobody gave.
      if (status.state === 'running' || status.state === 'stopped' || status.state === 'error') {
        setProgressLine('');
      }
    });
    const offProgress = ipcBridge.omnirouteGateway.onInstallProgress.on((p) => {
      setProgressLine(p.message);
    });
    return () => {
      offStatus();
      offProgress();
    };
  }, []);

  const persist = useCallback(
    async (nextEnabled: boolean): Promise<boolean> => {
      setSaving(true);
      try {
        const result = await ipcBridge.omnirouteGateway.setConfig.invoke({
          enabled: nextEnabled,
          baseUrl,
          // Empty input = keep the stored key untouched.
          ...(apiKey.length > 0 ? { apiKey } : {}),
        });
        if (!result?.ok) {
          Message.error(
            result?.error === 'invalid-base-url'
              ? t('settings.omnirouteGateway.invalidUrl')
              : t('settings.omnirouteGateway.saveError')
          );
          return false;
        }
        if (apiKey.length > 0) {
          setHasStoredKey(true);
          setApiKey('');
        }
        Message.success(t('settings.omnirouteGateway.saved'));
        return true;
      } catch (err) {
        Message.error(err instanceof Error ? err.message : t('settings.omnirouteGateway.saveError'));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [apiKey, baseUrl, t]
  );

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (saving) return;
      const previous = enabled;
      setEnabled(next);
      const ok = await persist(next);
      if (!ok) setEnabled(previous);
    },
    [enabled, persist, saving]
  );

  const handleSave = useCallback(async () => {
    if (saving) return;
    await persist(enabled);
  }, [enabled, persist, saving]);

  const handleTest = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await ipcBridge.omnirouteGateway.testConnection.invoke({
        baseUrl,
        ...(apiKey.length > 0 ? { apiKey } : {}),
      });
      setTestResult(result ?? { ok: false, error: 'unreachable' });
    } catch {
      setTestResult({ ok: false, error: 'unreachable' });
    } finally {
      setTesting(false);
    }
  }, [apiKey, baseUrl, testing]);

  /** One-click: install, then start, then open OmniRoute's OWN dashboard. */
  const handleInstallAndRun = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setProgressLine('');
    try {
      const installed = await ipcBridge.omnirouteGateway.install.invoke();
      if (installed) setRuntime(installed);
      if (!installed || installed.state === 'error') {
        Message.error(
          t('settings.omnirouteGateway.autoInstall.installFailed', { error: installed?.error ?? 'unknown' })
        );
        return;
      }
      const started = await ipcBridge.omnirouteGateway.start.invoke();
      if (started) setRuntime(started);
      if (!started || started.state !== 'running') {
        Message.error(t('settings.omnirouteGateway.autoInstall.startFailed', { error: started?.error ?? 'unknown' }));
        return;
      }
      // Open OmniRoute's OWN dashboard - the USER connects a provider there.
      // The opt-in switch is deliberately left untouched: installing a server is
      // not consent to relay prompts through third parties.
      await ipcBridge.omnirouteGateway.openDashboard.invoke();
      Message.success(t('settings.omnirouteGateway.autoInstall.running'));
    } catch (err) {
      Message.error(err instanceof Error ? err.message : t('settings.omnirouteGateway.saveError'));
    } finally {
      setBusy(false);
    }
  }, [busy, t]);

  const handleOpenDashboard = useCallback(async () => {
    try {
      await ipcBridge.omnirouteGateway.openDashboard.invoke();
    } catch {
      /* opening the dashboard is best-effort */
    }
  }, []);

  const handleStop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const status = await ipcBridge.omnirouteGateway.stop.invoke();
      if (status) setRuntime(status);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const handleInstallNode = useCallback(() => {
    void ipcBridge.shell.openExternal.invoke(NODEJS_DOWNLOAD_URL).catch((err: unknown) => {
      console.error('[OmniRouteGatewayCard] openExternal failed:', err);
    });
  }, []);

  const isRunning = runtime?.state === 'running';
  const isWorking = busy || runtime?.state === 'installing' || runtime?.state === 'starting';
  const pill = runtimePill(t, runtime);

  return (
    <div
      className='flex flex-col gap-12px p-16px rd-12px bg-aou-1'
      data-testid='omniroute-gateway-card'
      role='region'
      aria-label={t('settings.omnirouteGateway.title')}
    >
      <div className='flex items-center justify-between gap-16px'>
        <Typography.Text className='text-14px font-medium'>{t('settings.omnirouteGateway.title')}</Typography.Text>
        <Switch
          checked={enabled}
          loading={saving}
          onChange={(value: boolean) => {
            void handleToggle(value);
          }}
          data-testid='omniroute-gateway-switch'
        />
      </div>

      <Typography.Text type='secondary' className='text-12px'>
        {t('settings.omnirouteGateway.intro')}
      </Typography.Text>

      <div className='flex flex-col gap-4px'>
        <Typography.Text className='text-12px font-medium'>
          {t('settings.omnirouteGateway.benefitsTitle')}
        </Typography.Text>
        <ul className='m-0 pl-18px text-12px text-t-secondary'>
          <li>{t('settings.omnirouteGateway.benefit1')}</li>
          <li>{t('settings.omnirouteGateway.benefit2')}</li>
          <li>{t('settings.omnirouteGateway.benefit3')}</li>
          <li>{t('settings.omnirouteGateway.benefit4')}</li>
        </ul>
      </div>

      <div className='flex flex-col gap-4px'>
        <Typography.Text className='text-12px font-medium'>{t('settings.omnirouteGateway.risksTitle')}</Typography.Text>
        <ul className='m-0 pl-18px text-12px text-t-secondary'>
          <li>{t('settings.omnirouteGateway.risk1')}</li>
          <li>{t('settings.omnirouteGateway.risk2')}</li>
          <li>{t('settings.omnirouteGateway.risk3')}</li>
          <li>{t('settings.omnirouteGateway.risk4')}</li>
        </ul>
      </div>

      <Typography.Text type='secondary' className='text-12px'>
        {t('settings.omnirouteGateway.manualOnlyNote')}
      </Typography.Text>

      {/* C2: one-click auto-install + run (recommended path) */}
      <div className='flex flex-col gap-8px p-12px rd-8px bg-aou-2' data-testid='omniroute-gateway-autoinstall'>
        <div className='flex items-center justify-between gap-12px'>
          <Typography.Text className='text-13px font-medium'>
            {t('settings.omnirouteGateway.autoInstall.sectionTitle')}
          </Typography.Text>
          {pill && (
            <Tag color={pill.color} size='small' data-testid='omniroute-gateway-runtime-status'>
              {pill.text}
            </Tag>
          )}
        </div>

        <Typography.Text type='secondary' className='text-12px'>
          {t('settings.omnirouteGateway.autoInstall.sectionIntro')}
        </Typography.Text>

        <Typography.Text type='secondary' className='text-12px'>
          {t('settings.omnirouteGateway.autoInstall.connectYourselfNote')}
        </Typography.Text>

        {/* OmniRoute guards its own dashboard with its own password - saying so
            up front beats letting the user hit an unexplained login screen. */}
        <Typography.Text type='secondary' className='text-12px' data-testid='omniroute-gateway-dashboard-password-note'>
          {t('settings.omnirouteGateway.autoInstall.dashboardPasswordNote')}
        </Typography.Text>

        {/* Running != adopted-by-Darhai. Say which one this is. */}
        {isRunning && runtime?.owned === false && (
          <Typography.Text type='warning' className='text-12px' data-testid='omniroute-gateway-external-note'>
            {t('settings.omnirouteGateway.autoInstall.externalServerNote')}
          </Typography.Text>
        )}

        {/* Running is not consent: the relay stays off until the user flips it. */}
        {isRunning && !enabled && (
          <Typography.Text type='warning' className='text-12px' data-testid='omniroute-gateway-enable-hint'>
            {t('settings.omnirouteGateway.autoInstall.enableHint')}
          </Typography.Text>
        )}

        <div className='flex items-center gap-8px flex-wrap'>
          {!isRunning && (
            <Button
              size='small'
              type='primary'
              loading={isWorking}
              onClick={() => void handleInstallAndRun()}
              data-testid='omniroute-gateway-install-run'
            >
              {t('settings.omnirouteGateway.autoInstall.installButton')}
            </Button>
          )}
          {isRunning && (
            <>
              <Button
                size='small'
                type='primary'
                onClick={() => void handleOpenDashboard()}
                data-testid='omniroute-gateway-open-dashboard'
              >
                {t('settings.omnirouteGateway.autoInstall.openDashboard')}
              </Button>
              <Button
                size='small'
                status='danger'
                loading={busy}
                onClick={() => void handleStop()}
                data-testid='omniroute-gateway-stop'
              >
                {t('settings.omnirouteGateway.autoInstall.stopButton')}
              </Button>
            </>
          )}
        </div>

        {isWorking && progressLine.length > 0 && (
          <Typography.Text
            type='secondary'
            className='text-11px font-mono truncate'
            data-testid='omniroute-gateway-progress'
          >
            {progressLine}
          </Typography.Text>
        )}

        {runtime?.needsRuntime === true && (
          <div className='flex flex-col gap-4px'>
            <Typography.Text type='warning' className='text-12px'>
              {t('settings.omnirouteGateway.autoInstall.needsRuntime')}
            </Typography.Text>
            <Button size='mini' type='text' onClick={handleInstallNode} data-testid='omniroute-gateway-install-node'>
              {t('settings.omnirouteGateway.autoInstall.installNodeLink')}
            </Button>
          </div>
        )}
      </div>

      {/* Advanced / bring-your-own: point Darhai at an OmniRoute you run yourself. */}
      <Typography.Text type='secondary' className='text-12px font-medium'>
        {t('settings.omnirouteGateway.autoInstall.advancedTitle')}
      </Typography.Text>

      <Typography.Text type='secondary' className='text-12px'>
        {t('settings.omnirouteGateway.howTo')}
      </Typography.Text>

      <div className='flex flex-col gap-8px'>
        <div className='flex flex-col gap-4px'>
          <Typography.Text className='text-12px'>{t('settings.omnirouteGateway.baseUrlLabel')}</Typography.Text>
          <Input
            value={baseUrl}
            onChange={(value: string) => setBaseUrl(value)}
            placeholder={OMNIROUTE_GATEWAY_DEFAULT_BASE_URL}
            data-testid='omniroute-gateway-baseurl'
          />
        </div>
        <div className='flex flex-col gap-4px'>
          <Typography.Text className='text-12px'>{t('settings.omnirouteGateway.apiKeyLabel')}</Typography.Text>
          <Input.Password
            value={apiKey}
            onChange={(value: string) => setApiKey(value)}
            placeholder={
              hasStoredKey
                ? t('settings.omnirouteGateway.apiKeySetHint')
                : t('settings.omnirouteGateway.apiKeyPlaceholder')
            }
            data-testid='omniroute-gateway-apikey'
          />
        </div>
      </div>

      <div className='flex items-center gap-8px'>
        <Button size='small' loading={testing} onClick={() => void handleTest()}>
          {t('settings.omnirouteGateway.testButton')}
        </Button>
        <Button size='small' type='primary' loading={saving} onClick={() => void handleSave()}>
          {t('settings.omnirouteGateway.saveButton')}
        </Button>
        {testResult && (
          <Typography.Text
            className='text-12px'
            type={testResult.ok ? 'success' : 'error'}
            data-testid='omniroute-gateway-test-result'
          >
            {testResult.ok === true
              ? t('settings.omnirouteGateway.testOk', { count: testResult.modelCount })
              : errorText(t, testResult.error)}
          </Typography.Text>
        )}
      </div>
    </div>
  );
};

export default OmniRouteGatewayCard;
