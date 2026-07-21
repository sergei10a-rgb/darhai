/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Key, Right, Terminal } from '@icon-park/react';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './ActivationCard.module.css';

/** Which activation path the user chose - used for telemetry / analytics. */
export type ActivationPath = 'own-key' | 'claude-code';

export type ActivationCardProps = {
  /** Open the existing Browse / connect flow so the user adds their own key. */
  onUseOwnKey: () => void;
  /** Select Claude Code as the backend. */
  onUseClaudeCode: () => void;
  /**
   * Optional telemetry hook - fired with the chosen path before its action
   * runs. No dedicated telemetry util exists in the renderer yet, so the card
   * surfaces the event as a callback for the caller to forward.
   */
  onPathSelected?: (path: ActivationPath) => void;
};

type PathConfig = {
  path: ActivationPath;
  icon: React.ReactNode;
  labelKey: string;
  subLabelKey: string;
  actionKey: string;
  /** The primary path is rendered first + tinted. */
  primary: boolean;
  onSelect: () => void;
};

/**
 * In-thread activation card offering ranked paths to wake the engine when no
 * working inference provider is configured (see `useProviderReadiness`).
 *
 * Presentational only - every action is a callback prop; the card owns no IPC,
 * no registry state, and no navigation. "Use your own key" is the recommended
 * primary path.
 */
const ActivationCard: React.FC<ActivationCardProps> = ({ onUseOwnKey, onUseClaudeCode, onPathSelected }) => {
  const { t } = useTranslation();

  const select = useCallback(
    (path: ActivationPath, action: () => void) => {
      onPathSelected?.(path);
      action();
    },
    [onPathSelected]
  );

  const paths: PathConfig[] = [
    {
      path: 'own-key',
      icon: <Key />,
      labelKey: 'conversation.activation.ownKey.label',
      subLabelKey: 'conversation.activation.ownKey.sublabel',
      actionKey: 'conversation.activation.ownKey.action',
      primary: true,
      onSelect: () => select('own-key', onUseOwnKey),
    },
    {
      path: 'claude-code',
      icon: <Terminal />,
      labelKey: 'conversation.activation.claudeCode.label',
      subLabelKey: 'conversation.activation.claudeCode.sublabel',
      actionKey: 'conversation.activation.claudeCode.action',
      primary: false,
      onSelect: () => select('claude-code', onUseClaudeCode),
    },
  ];

  const titleId = 'activation-card-title';

  return (
    <section className={`${styles.card} flex flex-col gap-12px rd-16px p-16px`} role='region' aria-labelledby={titleId}>
      <div className='flex flex-col gap-4px'>
        <div id={titleId} className='text-14px text-t-primary font-600'>
          {t('conversation.activation.title')}
        </div>
        <div className='text-12px text-t-secondary'>{t('conversation.activation.subtitle')}</div>
      </div>

      <ul className='flex flex-col gap-8px' role='list'>
        {paths.map((p) => (
          <li
            key={p.path}
            role='listitem'
            data-testid={`activation-path-${p.path}`}
            className={`${styles.row} ${p.primary ? styles.rowPrimary : ''} flex items-center gap-12px rd-12px p-12px`}
          >
            <span className={`${styles.icon} ${p.primary ? styles.iconPrimary : ''} flex items-center text-20px`}>
              {p.icon}
            </span>
            <div className='flex flex-1 flex-col gap-2px min-w-0'>
              <span className='text-13px text-t-primary font-500'>{t(p.labelKey)}</span>
              <span className='text-12px text-t-secondary'>{t(p.subLabelKey)}</span>
            </div>
            <Button
              type={p.primary ? 'primary' : 'secondary'}
              size='small'
              icon={<Right />}
              aria-label={t(p.actionKey)}
              onClick={p.onSelect}
            >
              {t(p.actionKey)}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default ActivationCard;
