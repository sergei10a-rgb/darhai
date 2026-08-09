/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { HardDrive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from '../panes/Panes.module.css';
import { useEngineConfigPath } from './useEngineConfigPath';

/**
 * The quiet "where this writes" line shown on every editable Darhai Core pane
 * (refinement B). Makes it truthful that these settings are the engine's own
 * `config.toml`, shared with the Darhai Core CLI, not Desktop-only state.
 *
 * The path is resolved from the main process rather than written into the
 * markup: it differs per platform and per active profile, and the hardcoded
 * `~/.wayland-core/config.toml` it replaced pointed at a file that exists on no
 * platform this app ships to.
 */
const ScopeLabel: React.FC = () => {
  const { t } = useTranslation();
  const configPath = useEngineConfigPath();
  return (
    <div className={styles.scopeLabel}>
      <HardDrive size={13} />
      <span>
        {t('settings.wcoreConfig.scopeWritesTo', { defaultValue: 'Writes to' })}{' '}
        {/* Before the path arrives, name the file without a path: still true,
            where a stale absolute path would not be. */}
        <code data-testid='engine-config-path'>{configPath ?? 'config.toml'}</code>{' '}
        {t('settings.wcoreConfig.scopeSharedCli', { defaultValue: 'Used by the Darhai Core CLI too.' })}
      </span>
    </div>
  );
};

export default ScopeLabel;
