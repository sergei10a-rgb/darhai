/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OmniRouteGatewayCard - the opt-in card for connecting a USER-RUN OmniRoute
 * gateway (Phase 7b). Hosted on the Models & Providers settings page.
 *
 * Owner conditions the card embodies:
 *  1. Honest Mongolian disclosure, default OFF - benefits AND risks are always
 *     visible above the switch; the toggle starts disabled and only the user
 *     flips it.
 *  2. Visible marking - the title carries the relay marking; the registered
 *     provider name repeats it in every model picker.
 *  3. Explicit selection only - the card states that enabling never makes the
 *     relay a default; the user picks it per conversation.
 *  4. User-run gateway - a how-to line tells the user to run `omniroute`
 *     themselves; Darhai only connects to the URL confirmed here.
 */

import { Button, Input, Message, Switch, Typography } from '@arco-design/web-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { OmnirouteGatewayTestResult } from '@/common/types/omnirouteGateway';
import { OMNIROUTE_GATEWAY_DEFAULT_BASE_URL } from '@/common/types/omnirouteGateway';

/** Map a service error token onto a localized message. */
function errorText(t: ReturnType<typeof useTranslation>['t'], token: string): string {
  if (token === 'invalid-base-url') return t('settings.omnirouteGateway.invalidUrl');
  return t('settings.omnirouteGateway.testFail', { error: token });
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
    return () => {
      disposed = true;
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
