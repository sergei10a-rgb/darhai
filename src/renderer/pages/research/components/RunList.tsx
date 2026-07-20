/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import classNames from 'classnames';
import type { ResearchRun, ResearchStatus } from '@/common/types/research';
import styles from '../Research.module.css';

const TERMINAL: ReadonlySet<ResearchStatus> = new Set<ResearchStatus>(['done', 'error', 'cancelled']);

/** i18n key for a run's status badge (terminal states have their own labels). */
function statusKey(status: ResearchStatus): string {
  return TERMINAL.has(status) ? `research.status.${status}` : `research.phase.${status}`;
}

interface RunListProps {
  runs: ResearchRun[];
  activeRunId: string | null;
  onSelect: (runId: string) => void;
}

/**
 * Recent-runs rail. A simple, queryable list of the user's latest research runs;
 * fuller Library facets (search / sort / archive) are deferred (secondary).
 */
const RunList: React.FC<RunListProps> = ({ runs, activeRunId, onSelect }) => {
  const { t } = useTranslation();

  return (
    <div className={styles.list} data-testid='research-run-list'>
      <div className={styles.listTitle}>{t('research.recent.title')}</div>
      {runs.length === 0 ? (
        <div className={styles.emptyList}>{t('research.recent.empty')}</div>
      ) : (
        runs.map((run) => (
          <div
            key={run.id}
            className={classNames(styles.runCard, run.id === activeRunId && styles.runCardActive)}
            onClick={() => onSelect(run.id)}
            role='button'
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(run.id);
              }
            }}
            data-testid='research-run-card'
          >
            <span className={styles.runCardQuery}>{run.query}</span>
            <span className={styles.runCardMeta}>
              <span>{t(statusKey(run.status))}</span>
              <span>·</span>
              <span>{new Date(run.updatedAtMs).toLocaleDateString()}</span>
            </span>
          </div>
        ))
      )}
    </div>
  );
};

export default RunList;
