/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Spin } from '@arco-design/web-react';
import { Check, X } from 'lucide-react';
import classNames from 'classnames';
import type { ResearchRun, ResearchStatus } from '@/common/types/research';
import styles from '../Research.module.css';

/** The ordered transient phases the rail paints (terminal states handled separately). */
const PHASES: ResearchStatus[] = ['planning', 'searching', 'reading', 'synthesizing', 'writing'];

const isRunning = (status: ResearchStatus): boolean => PHASES.includes(status);

interface RunProgressProps {
  run: ResearchRun;
  onCancel: (runId: string) => void;
}

/**
 * Live progress rail for a run: the ordered phase pills plus a cancel affordance
 * while active, and a notice for the terminal error / cancelled states. Reuses
 * the same phase vocabulary the workflow step-rail concept uses.
 */
const RunProgress: React.FC<RunProgressProps> = ({ run, onCancel }) => {
  const { t } = useTranslation();
  const running = isRunning(run.status);
  const activeIndex = PHASES.indexOf(run.status);

  const stepState = (index: number): 'done' | 'active' | 'pending' => {
    if (run.status === 'done') return 'done';
    if (!running) return index <= activeIndex ? 'done' : 'pending';
    if (index < activeIndex) return 'done';
    if (index === activeIndex) return 'active';
    return 'pending';
  };

  return (
    <div>
      <div className={styles.runHeader}>
        <div>
          <div className={styles.runQuery}>{run.query}</div>
          <div className={styles.runMeta}>
            <span>{t(`research.category.${run.category}`)}</span>
            <span>·</span>
            <span>{t('research.meta.rounds', { count: run.rounds })}</span>
            <span>·</span>
            <span>{t('research.meta.sources', { count: run.sources.length })}</span>
          </div>
        </div>
        {running ? (
          <Button
            size='small'
            status='danger'
            icon={<X size={14} />}
            onClick={() => onCancel(run.id)}
            data-testid='research-cancel'
          >
            {t('research.cancel')}
          </Button>
        ) : null}
      </div>

      <div className={styles.rail} data-testid='research-rail'>
        {PHASES.map((phase, index) => {
          const state = stepState(index);
          return (
            <React.Fragment key={phase}>
              {index > 0 ? <span className={styles.railConnector} /> : null}
              <span
                className={classNames(
                  styles.railStep,
                  state === 'done' && styles.railStepDone,
                  state === 'active' && styles.railStepActive
                )}
              >
                {state === 'active' ? <Spin size={12} /> : state === 'done' ? <Check size={13} /> : null}
                {t(`research.phase.${phase}`)}
              </span>
            </React.Fragment>
          );
        })}
      </div>

      {run.status === 'error' ? (
        <div className={classNames(styles.notice, styles.noticeError)} data-testid='research-error'>
          {run.error ? t('research.errorWithReason', { reason: run.error }) : t('research.errorGeneric')}
        </div>
      ) : null}
      {run.status === 'cancelled' ? (
        <div className={styles.notice} data-testid='research-cancelled'>
          {t('research.cancelledNotice')}
        </div>
      ) : null}
    </div>
  );
};

export default RunProgress;
