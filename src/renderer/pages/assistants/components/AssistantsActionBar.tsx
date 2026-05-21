/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Download, Plus } from 'lucide-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../AssistantsLibraryPage.module.css';

export type AssistantsActionBarProps = {
  totalCount: number;
  onBuildMyOwn: () => void;
};

const AssistantsActionBar: React.FC<AssistantsActionBarProps> = ({ totalCount, onBuildMyOwn }) => {
  const { t } = useTranslation();

  const handleImport = () => {
    // Import wiring is paralleled in the Workflows page — the Skill
    // Import flow (folder / git / zip / single SKILL.md) already
    // detects type via frontmatter, so a future wire reuses it for
    // assistants (which would arrive as `type: 'agent-profile'` or as
    // a presetAssistants entry depending on the source). Placeholder
    // until that pass lands.
    // eslint-disable-next-line no-alert
    window.alert(
      t('assistants.import.placeholder', {
        defaultValue:
          'Import wiring lands next: folder / git URL / SKILL.md with type:agent-profile auto-detected via frontmatter, scanned by Skill Guard, and registered as an Assistant.',
      }),
    );
  };

  return (
    <div className={styles.actionBar} data-testid='assistants-action-bar'>
      <h1 className={styles.actionBarTitle}>
        {t('assistants.title', { defaultValue: 'Assistants' })}
        <span className={styles.actionBarCount} data-testid='assistants-total-count'>
          {t('assistants.totalCount', { count: totalCount, defaultValue: '{{count}} assistants' })}
        </span>
      </h1>
      <div className='flex items-center gap-8px'>
        <Button
          type='secondary'
          icon={<Download size={14} />}
          onClick={handleImport}
          data-testid='assistants-import-cta'
        >
          {t('assistants.import.cta', { defaultValue: 'Import assistant' })}
        </Button>
        <Button
          type='primary'
          icon={<Plus size={14} />}
          onClick={onBuildMyOwn}
          data-testid='assistants-build-my-own-cta'
        >
          {t('assistants.buildMyOwn.cta', { defaultValue: 'Build my own' })}
        </Button>
      </div>
    </div>
  );
};

export default AssistantsActionBar;
