/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Telescope } from 'lucide-react';
import PageShell from '@renderer/components/layout/PageShell';
import { useResearch } from './useResearch';
import { ReportView, ResearchComposer, RunList, RunProgress } from './components';
import type { ResearchStatus } from '@/common/types/research';
import styles from './Research.module.css';

const RUNNING_STATUSES: ReadonlySet<ResearchStatus> = new Set<ResearchStatus>([
  'planning',
  'searching',
  'reading',
  'synthesizing',
  'writing',
]);

/**
 * Deep Research surface (Odysseus assimilation "deep research"). A first-class
 * /research page: a query composer, a live run view (phase rail + final report
 * via the shared MarkdownView), and a recent-runs rail. The main process owns
 * the loop; this page is presentation over the {@link useResearch} IPC client.
 */
const ResearchPage: React.FC = () => {
  const { t } = useTranslation();
  const { runs, activeRun, activeRunId, start, cancel, selectRun } = useResearch();

  const running = activeRun !== null && RUNNING_STATUSES.has(activeRun.status);
  const showReport = activeRun !== null && activeRun.status === 'done';

  return (
    <PageShell
      title={t('research.pageTitle')}
      icon={<Telescope size={20} />}
      subtitle={t('research.description')}
      countLabel={t('research.footer.count', { count: runs.length })}
      width='full'
      filterRail={<RunList runs={runs} activeRunId={activeRunId} onSelect={selectRun} />}
      testId='research-page'
    >
      <ResearchComposer running={running} onStart={start} />

      {activeRun ? (
        <div className={styles.runPanel}>
          <RunProgress run={activeRun} onCancel={cancel} />
          {showReport ? <ReportView run={activeRun} /> : null}
        </div>
      ) : (
        <div className={styles.empty} data-testid='research-empty'>
          <Telescope size={40} className={styles.emptyIcon} />
          <span className={styles.emptyTitle}>{t('research.empty.title')}</span>
          <span>{t('research.empty.hint')}</span>
        </div>
      )}
    </PageShell>
  );
};

export default ResearchPage;
