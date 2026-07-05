/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { HardDrive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from '../panes/Panes.module.css';

/**
 * The quiet "where this writes" line shown on every editable Wayland Core pane
 * (refinement B). Makes it truthful that these settings are the engine's own
 * `config.toml`, shared with the Wayland Core CLI, not Desktop-only state.
 */
const ScopeLabel: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className={styles.scopeLabel}>
      <HardDrive size={13} />
      <span>
        {t('settings.wcoreConfig.scopeWritesTo', { defaultValue: 'Writes to' })}{' '}
        <code>~/.wayland-core/config.toml</code>{' '}
        {t('settings.wcoreConfig.scopeSharedCli', { defaultValue: 'Used by the Darhai Core CLI too.' })}
      </span>
    </div>
  );
};

export default ScopeLabel;
