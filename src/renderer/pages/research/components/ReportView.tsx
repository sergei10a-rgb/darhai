/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import MarkdownView from '@renderer/components/Markdown';
import type { ResearchRun } from '@/common/types/research';
import styles from '../Research.module.css';

interface ReportViewProps {
  run: ResearchRun;
}

/**
 * Renders a finished run's markdown report. REUSES the app's shared MarkdownView
 * (inline citations open externally, GFM tables + code) - no new renderer. The
 * inline [title](url) citations + the appended Sources section come from the
 * service; this component only paints them.
 */
const ReportView: React.FC<ReportViewProps> = ({ run }) => {
  const { t } = useTranslation();

  if (!run.report.trim()) {
    return (
      <div className={styles.notice} data-testid='research-report-empty'>
        {t('research.report.empty')}
      </div>
    );
  }

  return (
    <div className={styles.report} data-testid='research-report'>
      <MarkdownView>{run.report}</MarkdownView>
    </div>
  );
};

export default ReportView;
