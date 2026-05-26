/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * InstallerPitchCard -- Wave 4 surface shown when IJFW status is
 * `not_installed`. Persistence-led pitch (handoff §4.4): headline + 3-bullet
 * value prop + single Install CTA. Skip lives in Settings per Decision 3b,
 * surfaced here as a small footer link only.
 *
 * On install click we call `ipcBridge.ijfw.triggerInstall.invoke()` and
 * disable the CTA with an inline spinner. MemoryPage swaps to InstallingCard
 * as soon as the bridge emits the `installing` status, so this card usually
 * unmounts within a tick -- the local disabled state is a defensive guard
 * against double-fires before the status flip arrives.
 */

import { Button, Spin } from '@arco-design/web-react';
import { Check } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ipcBridge } from '@/common';
import styles from './InstallerPitchCard.module.css';

const InstallerPitchCard: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isInstalling, setIsInstalling] = useState(false);

  const handleInstall = useCallback(async () => {
    if (isInstalling) return;
    setIsInstalling(true);
    try {
      await ipcBridge.ijfw.triggerInstall.invoke();
    } catch {
      // If the bridge rejects, flip the button back so the user can retry.
      // MemoryPage will route to InstallFailedCard if the lifecycle status
      // moves to `install_failed`; here we only own the local CTA state.
      setIsInstalling(false);
    }
  }, [isInstalling]);

  const handleSettings = useCallback(() => {
    navigate('/settings/ijfw');
  }, [navigate]);

  return (
    <div className={styles.center} data-testid='memory-installer-pitch'>
      <div className={styles.card}>
        <h2 className='text-24px font-semibold text-t-primary leading-32px m-0'>
          {t('memory.pitch.headline')}
        </h2>
        <p className='text-14px text-t-secondary leading-22px m-0'>
          {t('memory.pitch.lede')}
        </p>
        <ul className={styles.bullets}>
          <li className={styles.bullet}>
            <Check size={18} className={styles.checkIcon} aria-hidden />
            <span className='text-14px text-t-primary leading-22px'>{t('memory.pitch.bullet1')}</span>
          </li>
          <li className={styles.bullet}>
            <Check size={18} className={styles.checkIcon} aria-hidden />
            <span className='text-14px text-t-primary leading-22px'>{t('memory.pitch.bullet2')}</span>
          </li>
          <li className={styles.bullet}>
            <Check size={18} className={styles.checkIcon} aria-hidden />
            <span className='text-14px text-t-primary leading-22px'>{t('memory.pitch.bullet3')}</span>
          </li>
        </ul>
        <div className={styles.actions}>
          <Button
            type='primary'
            size='large'
            disabled={isInstalling}
            onClick={handleInstall}
            data-testid='memory-installer-pitch-install-cta'
          >
            {isInstalling ? (
              <span className={styles.installingRow}>
                <Spin size={14} />
                {t('memory.installing.title')}
              </span>
            ) : (
              t('memory.pitch.install_cta')
            )}
          </Button>
          <Button
            type='text'
            size='small'
            onClick={handleSettings}
            data-testid='memory-installer-pitch-settings-link'
          >
            {t('memory.pitch.settings_link')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default InstallerPitchCard;
