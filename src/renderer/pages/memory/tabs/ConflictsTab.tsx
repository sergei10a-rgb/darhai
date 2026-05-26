/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wave 5 -- ConflictsTab surfaces memory entries IJFW detects as contradicting
 * each other (e.g., "we use postgres" vs "we migrated to dynamodb"). The list
 * is fetched via the `memory_facts` verb with `conflicts: true`, rendered as
 * stacked clusters: each cluster shows the conflict subject (the `fact`) and
 * a sub-list of variants. Picking a "Keep this" winner calls
 * `conflict.resolve` and, on success, refetches the list so the resolved
 * cluster drops out.
 *
 * Loading / error / empty UX is delegated to MCPVerbCard for parity with the
 * other Memory tabs.
 */

import { Button, Message } from '@arco-design/web-react';
import { AlertCircle, Check } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { MCPVerbCard } from '@renderer/pages/memory/components/MCPVerbCard';
import { useIjfwBrain } from '@renderer/pages/memory/hooks/useIjfwBrain';
import styles from './ConflictsTab.module.css';

type Variant = {
  id: string;
  preview: string;
  createdAt: number;
  source?: string;
};

type Conflict = {
  id: string;
  fact: string;
  variants: Variant[];
};

type ConflictsPayload = { conflicts: Conflict[] };

type EmptyProps = { text: string };
const EmptyState: React.FC<EmptyProps> = ({ text }) => (
  <div className={styles.empty} data-testid='memory-conflicts-empty'>
    {text}
  </div>
);

type ConflictClusterProps = {
  conflict: Conflict;
  onKeep: (conflictId: string, winnerVariantId: string) => void;
  pendingVariantId: string | null;
  keepLabel: string;
};
const ConflictCluster: React.FC<ConflictClusterProps> = ({
  conflict,
  onKeep,
  pendingVariantId,
  keepLabel,
}) => (
  <div
    className={styles.cluster}
    data-testid={`memory-conflicts-cluster-${conflict.id}`}
  >
    <h3 className={styles.clusterTitle}>
      <AlertCircle size={14} aria-hidden />
      {conflict.fact}
    </h3>
    <div className={styles.variantList}>
      {conflict.variants.map((variant) => (
        <div
          key={variant.id}
          className={styles.variantRow}
          data-testid={`memory-conflicts-variant-${variant.id}`}
        >
          <span className={styles.variantPreview}>{variant.preview}</span>
          <Button
            type='primary'
            size='mini'
            icon={<Check size={12} aria-hidden />}
            loading={pendingVariantId === variant.id}
            onClick={() => onKeep(conflict.id, variant.id)}
            data-testid={`memory-conflicts-keep-${variant.id}`}
          >
            {keepLabel}
          </Button>
        </div>
      ))}
    </div>
  </div>
);

const ConflictsTab: React.FC = () => {
  const { t } = useTranslation();

  // Bumped on a successful resolve to force the conflicts list to refetch.
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingVariantId, setPendingVariantId] = useState<string | null>(null);

  const conflictsState = useIjfwBrain<ConflictsPayload>(
    'memory_facts',
    { conflicts: true },
    [refreshKey]
  );

  const handleKeep = useCallback(
    async (conflictId: string, winnerVariantId: string) => {
      setPendingVariantId(winnerVariantId);
      try {
        const result = await ipcBridge.ijfw.brainInvoke.invoke({
          verb: 'conflict.resolve',
          args: { conflictId, winnerVariantId },
        });
        if (result.ok === true) {
          // TODO: i18n Wave 6 followup translate -- memory.conflicts.*
          Message.success(t('memory.conflicts.resolve_success'));
          setRefreshKey((n) => n + 1);
        } else {
          const reason = result.errorReason ?? 'unknown';
          Message.error(
            t(`memory.error.${reason}`, { defaultValue: t('memory.error.unknown') })
          );
        }
      } catch {
        Message.error(t('memory.error.unknown'));
      } finally {
        setPendingVariantId(null);
      }
    },
    [t]
  );

  return (
    <div className={styles.root} data-testid='memory-tab-conflicts'>
      <MCPVerbCard
        state={conflictsState}
        empty={<EmptyState text={t('memory.conflicts.empty')} />}
        render={(data) =>
          data.conflicts.length === 0 ? (
            <EmptyState text={t('memory.conflicts.empty')} />
          ) : (
            <div className={styles.clusterList} data-testid='memory-conflicts-list'>
              {data.conflicts.map((conflict) => (
                <ConflictCluster
                  key={conflict.id}
                  conflict={conflict}
                  onKeep={handleKeep}
                  pendingVariantId={pendingVariantId}
                  keepLabel={t('memory.conflicts.keep_this')}
                />
              ))}
            </div>
          )
        }
      />
    </div>
  );
};

export default ConflictsTab;
