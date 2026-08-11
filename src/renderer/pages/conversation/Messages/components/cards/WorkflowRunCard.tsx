/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageWorkflowRun, WorkflowRunFailure } from '@/common/chat/chatLib';
import { Attention, CheckOne, CloseOne } from '@icon-park/react';
import { Spin, Tag } from '@arco-design/web-react';
import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CardDisclosureHeader from './CardDisclosureHeader';
import styles from './WorkflowRunCard.module.css';

type WorkflowRunNode = NonNullable<IMessageWorkflowRun['content']['nodes']>[number];
type NodeState = WorkflowRunNode['state'];

/**
 * Arco preset tag colour per node state. `blocked` is orange rather than red on
 * purpose: the engine's schema lists it as a node state that is neither a
 * success nor a failure, and painting it red would tell the user something
 * broke when nothing has yet.
 */
const NODE_STATE_COLOR: Record<NodeState, string> = {
  queued: 'gray',
  running: 'arcoblue',
  succeeded: 'green',
  failed: 'red',
  blocked: 'orange',
};

/**
 * Failure block shared by a failed node and a failed run.
 *
 * `code` is printed verbatim - it is an engine identifier the user may have to
 * quote in a bug report, so translating or prettifying it would destroy its
 * only value. `retryable` is rendered as an explicit yes/no badge because
 * "will this come back on its own?" is the single question a failed run raises.
 */
const FailureDetail: React.FC<{ failure: WorkflowRunFailure }> = ({ failure }) => {
  const { t } = useTranslation();
  return (
    <div className={styles.failure}>
      <div className={styles.failureHead}>
        <code className={styles.code}>{failure.code}</code>
        <Tag size='small' color={failure.retryable ? 'orange' : 'red'}>
          {failure.retryable ? t('conversation.workflowRun.retryable') : t('conversation.workflowRun.notRetryable')}
        </Tag>
      </div>
      <div className={styles.failureMessage}>{failure.message}</div>
    </div>
  );
};

/**
 * In-transcript card for one `.ron` workflow run (`workflow_lifecycle_v1`).
 *
 * Before this card existed a workflow node that failed was invisible: the event
 * hit the decoder's default arm, matched the acknowledged-inert list, and was
 * dropped - the conversation simply went quiet. Everything here is therefore
 * driven by the engine's own projection; where the projection says nothing, the
 * card says nothing rather than filling the gap with a zero.
 */
const WorkflowRunCard: React.FC<{ message: IMessageWorkflowRun }> = ({ message }) => {
  const { t } = useTranslation();
  const { workflowId, name, nodeCount, status, missingTotal, nodes, failure } = message.content;
  const [expanded, setExpanded] = useState(true);
  const bodyId = `workflow-run-${useId()}`;

  const isRunning = status === 'running';
  const isSucceeded = status === 'succeeded';
  const isFailed = status === 'failed';

  const statusLabel = isSucceeded
    ? t('conversation.workflowRun.statusSucceeded')
    : isFailed
      ? t('conversation.workflowRun.statusFailed')
      : t('conversation.workflowRun.statusRunning');

  // A run always has a workflow_id; `name` is a display string that the engine
  // may leave empty. Falling back to the id keeps the card identifiable instead
  // of showing a nameless header.
  const title = name || workflowId || t('conversation.workflowRun.untitled');

  // Absence is a third state, not a zero. `nodes: []` means "a node list
  // arrived and it was empty"; no `nodes` at all means the projection never
  // reported one, and saying "0 steps reported" for that is the card asserting
  // a measurement nobody made.
  const observedNodes: WorkflowRunNode[] | null = Array.isArray(nodes) ? nodes : null;
  const declaredCount = typeof nodeCount === 'number' ? nodeCount : null;
  const lostLines = typeof missingTotal === 'number' ? missingTotal : null;

  // The engine's DECLARED node_count is shown only when it disagrees with what
  // actually arrived. Rendering "1 of 0" - which the `after-terminal` fixture
  // produces - would report the engine's own inconsistency as a Darhai bug; and
  // with either side unknown there is no disagreement to report, only two
  // unknowns, so the line is omitted rather than printed against `undefined`.
  const declaredDiffers = declaredCount !== null && observedNodes !== null && declaredCount !== observedNodes.length;

  return (
    <div className={styles.container} data-testid='workflow-run-card' data-workflow-status={status}>
      <hr className={styles.divider} />
      <CardDisclosureHeader
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        label={`${title} - ${statusLabel}`}
        bodyId={bodyId}
        leading={
          <>
            {isRunning && <Spin size={12} />}
            {isSucceeded && <CheckOne theme='filled' size={14} className={styles.iconDone} />}
            {isFailed && <CloseOne theme='filled' size={14} className={styles.iconFailed} />}
          </>
        }
      />

      {expanded && (
        <div className={styles.body} id={bodyId}>
          <div className={styles.meta}>
            <span data-testid='workflow-run-observed'>
              {observedNodes === null
                ? t('conversation.workflowRun.nodesUnknown')
                : t('conversation.workflowRun.nodesObserved', { observed: observedNodes.length })}
            </span>
            {declaredDiffers && (
              <span className={styles.metaMuted}>
                {t('conversation.workflowRun.nodesDeclared', { declared: declaredCount })}
              </span>
            )}
          </div>

          {/* The stream lost lines. `missingTotal` and not `missingSequences.length`:
              the reducer caps the list it enumerates but always counts the true
              loss, so the shorter list would under-report how much is missing.
              A projection that omits the field gets the same box with a
              different sentence: staying silent would let "never counted" pass
              for "counted, and nothing was lost". */}
          {lostLines === null ? (
            <div className={styles.warning} data-testid='workflow-run-gap-unknown'>
              <Attention theme='filled' size={13} className={styles.iconWarning} />
              <span>{t('conversation.workflowRun.linesLostUnknown')}</span>
            </div>
          ) : (
            lostLines > 0 && (
              <div className={styles.warning} data-testid='workflow-run-gap'>
                <Attention theme='filled' size={13} className={styles.iconWarning} />
                {/* `lines`, not `count`: i18next treats `count` as the plural
                    selector and would look for `linesLost_one`/`_other` keys that
                    no locale defines, silently dropping the number. */}
                <span>{t('conversation.workflowRun.linesLost', { lines: lostLines })}</span>
              </div>
            )
          )}

          {observedNodes === null ? (
            // Distinct from the empty state below: there, a list arrived and was
            // empty. Here no list arrived, so the card knows nothing about steps
            // and says exactly that.
            <div className={styles.empty} data-testid='workflow-run-nodes-unknown'>
              {t('conversation.workflowRun.noNodeList')}
            </div>
          ) : observedNodes.length === 0 ? (
            // Not a blank panel: a run can legitimately be open with no node
            // event yet, and saying so is the difference between "nothing has
            // happened" and "the card is broken".
            <div className={styles.empty} data-testid='workflow-run-empty'>
              {isRunning ? t('conversation.workflowRun.noNodesYet') : t('conversation.workflowRun.noNodesReported')}
            </div>
          ) : (
            <ul className={styles.nodeList}>
              {observedNodes.map((node) => (
                <li key={node.nodeId} className={styles.node} data-node-state={node.state}>
                  <div className={styles.nodeHead}>
                    <span className={styles.nodeId}>{node.nodeId}</span>
                    <Tag size='small' color={NODE_STATE_COLOR[node.state]}>
                      {t(`conversation.workflowRun.nodeState.${node.state}`)}
                    </Tag>
                  </div>
                  {node.failure && <FailureDetail failure={node.failure} />}
                </li>
              ))}
            </ul>
          )}

          {/* A run can fail without any node carrying the reason - the engine
              puts the cause on `workflow_finished` itself in that case. */}
          {failure && (
            <div className={styles.runFailure} data-testid='workflow-run-failure'>
              <div className={styles.runFailureTitle}>{t('conversation.workflowRun.runFailed')}</div>
              <FailureDetail failure={failure} />
            </div>
          )}
        </div>
      )}
      <hr className={styles.divider} />
    </div>
  );
};

export default WorkflowRunCard;
