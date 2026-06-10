import React, { useCallback, useState } from 'react';
import { Button, Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { XaiOAuthResult } from '@/common/types/onboarding';

/** Inline X (formerly Twitter) wordmark. The monochrome glyph adapts to theme. */
const XMark: React.FC = () => (
  <svg viewBox='0 0 24 24' width={14} height={14} fill='currentColor' aria-hidden focusable='false'>
    <path d='M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817-5.967 6.817H1.677l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z' />
  </svg>
);

/** Map each OAuth failure reason to its inline-message i18n key suffix. */
const ERROR_KEY: Record<Exclude<XaiOAuthResult, { ok: true }>['error'], string> = {
  unauthorized: 'xaiUnauthorized',
  'no-credit': 'xaiNoCredit',
  offline: 'xaiOffline',
  cancelled: 'xaiCancelled',
  timeout: 'xaiFailed',
  unknown: 'xaiFailed',
};

/**
 * "Sign in with X (Grok)" - native xAI OAuth connect.
 *
 * Wired to `ipcBridge.xaiAuth.login`, which runs the OAuth 2.0 PKCE flow against
 * `accounts.x.ai` (or reuses an existing `~/.grok/auth.json` credential) and
 * persists the bearer token through the model-registry connect path as the
 * `xai` provider. On success the home picker / model selection can use Grok via
 * the user's SuperGrok / X Premium subscription - no API key, no CLI on PATH.
 */
const XGrokButton: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  const handleClick = useCallback(async () => {
    setLoading(true);
    try {
      const res: XaiOAuthResult = await ipcBridge.xaiAuth.login.invoke();
      if (res.ok) {
        Message.success(
          res.reused
            ? t('settings.modelsPage.connect.xaiReused')
            : t('settings.modelsPage.connect.xaiSuccess')
        );
        return;
      }
      if ('error' in res) {
        Message.error(t(`settings.modelsPage.connect.${ERROR_KEY[res.error]}`));
      }
    } catch {
      Message.error(t('settings.modelsPage.connect.xaiFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  return (
    <Button long loading={loading} icon={<XMark />} onClick={() => void handleClick()}>
      {t('settings.modelsPage.connect.xai')}
    </Button>
  );
};

export default XGrokButton;
