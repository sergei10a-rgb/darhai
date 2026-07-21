/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpAuthRemedy } from '@/renderer/pages/conversation/platforms/acp/acpAuthFailure';
import { Button } from '@arco-design/web-react';
import { Close, Key, Right, Terminal } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from './AcpAuthFailureCard.module.css';

export type AcpAuthFailureCardProps = {
  /** Describes which remedies apply to the failed backend. */
  remedy: AcpAuthRemedy;
  /** Open Settings so the user adds a provider API key. Shown when remedy.providerKeyLabel is set. */
  onAddKey?: () => void;
  /** Copy the CLI login command / open docs. Shown when remedy.cliLoginCmd is set. */
  onCliLogin?: () => void;
  /** Optional dismiss handler - hides the card. */
  onDismiss?: () => void;
};

type ActionConfig = {
  key: string;
  icon: React.ReactNode;
  label: string;
  subLabel: string;
  action: string;
  /** The primary action is rendered tinted. */
  primary: boolean;
  onSelect: () => void;
};

/**
 * In-thread failure card shown when an ACP CLI cannot authenticate. The remedy
 * descriptor drives which fixes appear: add a provider API key (when one
 * applies), or run the CLI's login command. The title and explainer adapt to
 * whether the vendor blocks subscription OAuth logins inside third-party tools.
 *
 * Presentational only - every action is a callback prop; the card owns no IPC
 * and no navigation.
 */
const AcpAuthFailureCard: React.FC<AcpAuthFailureCardProps> = ({ remedy, onAddKey, onCliLogin, onDismiss }) => {
  const { t } = useTranslation();

  const actions: ActionConfig[] = [];

  if (remedy.providerKeyLabel && onAddKey) {
    actions.push({
      key: 'addKey',
      icon: <Key />,
      label: t('conversation.acpAuthFailure.addKey.label', { provider: remedy.providerKeyLabel }),
      subLabel: t('conversation.acpAuthFailure.addKey.sublabel'),
      action: t('conversation.acpAuthFailure.addKey.action'),
      primary: true,
      onSelect: onAddKey,
    });
  }

  if (remedy.cliLoginCmd && onCliLogin) {
    actions.push({
      key: 'cliLogin',
      icon: <Terminal />,
      label: t('conversation.acpAuthFailure.cliLogin.label'),
      subLabel: t('conversation.acpAuthFailure.cliLogin.sublabel', { cmd: remedy.cliLoginCmd }),
      action: t('conversation.acpAuthFailure.cliLogin.action'),
      primary: false,
      onSelect: onCliLogin,
    });
  }

  const titleId = 'acp-auth-card-title';
  const explainerKey =
    remedy.explainerKey ??
    (remedy.subscriptionOAuthBlocked
      ? 'conversation.acpAuthFailure.subscriptionExplainer'
      : 'conversation.acpAuthFailure.genericExplainer');

  return (
    <section className={`${styles.card} flex flex-col gap-12px rd-16px p-16px`} role='region' aria-labelledby={titleId}>
      <div className='flex items-start gap-8px'>
        <div className='flex flex-1 flex-col gap-4px min-w-0'>
          <div id={titleId} className='text-14px text-t-primary font-600'>
            {t('conversation.acpAuthFailure.title', { backend: remedy.backendLabel })}
          </div>
          <div className='text-12px text-t-secondary'>
            {t(explainerKey, { backend: remedy.backendLabel, provider: remedy.providerKeyLabel ?? '' })}
          </div>
        </div>
        {onDismiss && (
          <Button
            type='text'
            size='mini'
            icon={<Close />}
            aria-label={t('conversation.acpAuthFailure.dismiss')}
            onClick={onDismiss}
          />
        )}
      </div>

      <ul className='flex flex-col gap-8px' role='list'>
        {actions.map((a) => (
          <li
            key={a.key}
            role='listitem'
            data-testid={`acp-auth-action-${a.key}`}
            className={`${styles.row} ${a.primary ? styles.rowPrimary : ''} flex items-center gap-12px rd-12px p-12px`}
          >
            <span className={`${styles.icon} ${a.primary ? styles.iconPrimary : ''} flex items-center text-20px`}>
              {a.icon}
            </span>
            <div className='flex flex-1 flex-col gap-2px min-w-0'>
              <span className='text-13px text-t-primary font-500'>{a.label}</span>
              <span className='text-12px text-t-secondary'>{a.subLabel}</span>
            </div>
            <Button
              type={a.primary ? 'primary' : 'secondary'}
              size='small'
              icon={<Right />}
              aria-label={a.action}
              onClick={a.onSelect}
            >
              {a.action}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default AcpAuthFailureCard;
