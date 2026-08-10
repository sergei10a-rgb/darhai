/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageSubAgent } from '@/common/chat/chatLib';
import { Spin } from '@arco-design/web-react';
import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CardDisclosureHeader from './CardDisclosureHeader';
import styles from './SubAgentActivityCard.module.css';

const SubAgentActivityCard: React.FC<{ message: IMessageSubAgent }> = ({ message }) => {
  const { t } = useTranslation();
  const { agentName, status, body } = message.content;
  const [expanded, setExpanded] = useState(true);
  const bodyId = `sub-agent-${useId()}`;

  const isDone = status === 'done';
  const isFailed = status === 'failed';
  const isRunning = status === 'running';

  const statusLabel = isDone
    ? t('conversation.subAgent.statusDone', { defaultValue: 'Done' })
    : isFailed
      ? t('conversation.subAgent.statusFailed', { defaultValue: 'Failed' })
      : t('conversation.subAgent.statusRunning', { defaultValue: 'Running' });

  const headerLabel = `${agentName} - ${statusLabel}`;

  return (
    <div
      className={styles.container}
      data-sub-agent-status={status}
      data-sub-agent-name={agentName}
      data-testid='sub-agent-activity-card'
    >
      <hr className={styles.divider} />
      <CardDisclosureHeader
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        label={headerLabel}
        bodyId={bodyId}
        emphasis='muted'
        leading={
          <>
            {isRunning && <Spin size={12} />}
            {isDone && <span className={styles.dotDone} aria-label={t('conversation.subAgent.statusDone')} />}
            {isFailed && <span className={styles.dotFailed} aria-label={t('conversation.subAgent.statusFailed')} />}
          </>
        }
      />
      {body && (
        <div id={bodyId} className={`${styles.body} ${!expanded ? styles.collapsed : ''}`}>
          {body}
        </div>
      )}
      <hr className={styles.divider} />
    </div>
  );
};

export default SubAgentActivityCard;
