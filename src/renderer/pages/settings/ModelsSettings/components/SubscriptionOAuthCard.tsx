/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The subscription-OAuth card: sign into Darhai with an existing Claude Max /
 * ChatGPT / GitHub Copilot subscription instead of an API key. Hosted on the
 * Models & Providers settings page.
 *
 * Consent-first, mirroring OmniRouteGatewayCard: the disclosure text and the
 * single "I accept" checkbox sit ABOVE the provider list, and every "Sign in"
 * button is disabled until BOTH gate flags are on (the checkbox turns them on
 * together). Nothing - no port, no browser, no token - happens before that.
 */

import { Button, Checkbox, Divider, Input, Tag } from '@arco-design/web-react';
import { CheckCircle2 } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubscriptionProviderInfo } from '@/common/types/subscriptionOAuth';
import { useSubscriptionOAuth } from '../hooks/useSubscriptionOAuth';

/** The pending free-text prompt input (redirect URL / device code). */
const PromptField: React.FC<{ message: string; placeholder?: string; onSubmit: (value: string) => void }> = ({
  message,
  placeholder,
  onSubmit,
}) => {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  return (
    <div className='flex flex-col gap-6px mt-8px' data-testid='subscription-prompt'>
      <span className='text-12px text-t-secondary'>{message}</span>
      <div className='flex items-center gap-8px'>
        <Input
          size='small'
          value={value}
          placeholder={placeholder}
          onChange={(next: string) => setValue(next)}
          className='flex-1'
        />
        <Button size='small' type='primary' onClick={() => onSubmit(value)}>
          {t('settings.subscriptionOAuth.promptSubmit')}
        </Button>
      </div>
    </div>
  );
};

/** One provider row: label, readiness tag, status, and the sign-in / disconnect action. */
const ProviderRow: React.FC<{
  provider: SubscriptionProviderInfo;
  connected: boolean;
  loginAllowed: boolean;
  busy: boolean;
  anyBusy: boolean;
  onLogin: () => void;
  onDisconnect: () => void;
}> = ({ provider, connected, loginAllowed, busy, anyBusy, onLogin, onDisconnect }) => {
  const { t } = useTranslation();
  return (
    <div
      className='flex items-center justify-between gap-12px min-h-32px'
      data-testid={`subscription-provider-${provider.id}`}
    >
      <div className='flex flex-col'>
        <span className='flex items-center gap-6px text-13px text-t-primary'>
          {provider.label}
          {provider.readiness === 'experimental' && (
            <Tag size='small' color='orange'>
              {t('settings.subscriptionOAuth.experimental')}
            </Tag>
          )}
        </span>
        <span className='text-12px text-t-tertiary'>{provider.subscriptionName}</span>
      </div>
      {connected ? (
        <div className='flex items-center gap-8px'>
          <span className='flex items-center gap-6px text-12px text-[var(--success)]'>
            <CheckCircle2 size={14} />
            {t('settings.subscriptionOAuth.connected')}
          </span>
          <Button size='small' status='danger' onClick={onDisconnect}>
            {t('settings.subscriptionOAuth.disconnect')}
          </Button>
        </div>
      ) : (
        <Button
          size='small'
          type='primary'
          disabled={!loginAllowed || anyBusy}
          loading={busy}
          onClick={onLogin}
          data-testid={`subscription-login-${provider.id}`}
        >
          {t('settings.subscriptionOAuth.login')}
        </Button>
      )}
    </div>
  );
};

export const SubscriptionOAuthCard: React.FC = () => {
  const { t } = useTranslation();
  const {
    providers,
    disclosure,
    gate,
    statuses,
    auth,
    prompt,
    progress,
    busyProviderId,
    loginAllowed,
    setAcknowledged,
    login,
    disconnect,
    submitPrompt,
  } = useSubscriptionOAuth();

  // Bridge unavailable (WebUI) or nothing to show: render nothing.
  if (disclosure === null || providers.length === 0) return null;

  return (
    <div
      className='px-[12px] md:px-[32px] py-[24px] bg-[var(--color-bg-2)] rd-12px border-2 border-solid border-[var(--color-border-2)]'
      data-testid='subscription-oauth-card'
    >
      <div className='flex flex-col gap-4px mb-8px'>
        <span className='text-14px text-t-primary'>{t('settings.subscriptionOAuth.title')}</span>
        <span className='text-13px text-t-secondary'>{t('settings.subscriptionOAuth.description')}</span>
      </div>

      <Divider className='mt-0px mb-16px' />

      {/* Disclosure first, then the single accept checkbox, then the providers. */}
      <div className='flex flex-col gap-6px mb-12px'>
        <span className='text-13px text-t-primary'>{disclosure.title}</span>
        {disclosure.body.map((line, i) => (
          <span key={i} className='text-12px text-t-tertiary'>
            {line}
          </span>
        ))}
      </div>

      <Checkbox
        checked={gate.disclosureAcknowledged}
        onChange={(checked: boolean) => void setAcknowledged(checked)}
        data-testid='subscription-ack'
      >
        <span className='text-13px text-t-primary'>{disclosure.acknowledgeLabel}</span>
      </Checkbox>

      <Divider className='mt-16px mb-16px' />

      <div className='flex flex-col gap-12px'>
        {providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            connected={statuses[provider.id] === true}
            loginAllowed={loginAllowed}
            busy={busyProviderId === provider.id}
            anyBusy={busyProviderId !== null}
            onLogin={() => void login(provider.id)}
            onDisconnect={() => void disconnect(provider.id)}
          />
        ))}
      </div>

      {auth !== null && (
        <div className='flex flex-col gap-4px mt-12px'>
          <span className='text-12px text-t-secondary'>{t('settings.subscriptionOAuth.browserOpened')}</span>
          <span className='text-12px text-t-tertiary break-all'>{auth.url}</span>
        </div>
      )}

      {prompt !== null && (
        <PromptField
          message={prompt.message}
          placeholder={prompt.placeholder}
          onSubmit={(value) => void submitPrompt(value)}
        />
      )}

      {progress !== null && <span className='text-12px text-t-tertiary mt-8px'>{progress}</span>}
    </div>
  );
};

export default SubscriptionOAuthCard;
