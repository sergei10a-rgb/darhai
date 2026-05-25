/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Workflow } from 'lucide-react';

import { ipcBridge } from '@/common';
import AssistantIconTile from '@/renderer/pages/guid/components/AssistantIconTile';
import { resolveWorkflowPalette } from '@/renderer/pages/guid/components/workflow/workflowPalette';
import type { WorkflowSession } from '@/common/types/workflowTypes';

import styles from './InFlightWorkflowsStrip.module.css';

/**
 * Cross-workflow discovery surface for the GuidPage empty state. Renders the
 * most recent in-flight workflow sessions across the user's history (resolved
 * via `workflow.findAllActive({ limit: 3 })`) as up to three clickable cards
 * above the existing "Jump back in" recents row.
 *
 * Source of truth: SPEC §5.9 (NEW per audit — Codex finding #7 partial).
 *
 * Behavior:
 *  - On mount, fetches up to 3 in-flight sessions.
 *  - 0 results → renders nothing (no "no workflows yet" empty state).
 *  - 1+ results → renders an "In-flight workflows" heading + a row of cards.
 *  - Click on a card → calls `onResume(session)`; the caller is responsible
 *    for navigating to /guid with the workflowSessionId in location.state.
 *  - Loading flash is intentionally silent (renders nothing) — the component
 *    is small and cheap; a Spin here would create visual jitter on the empty
 *    state for the common 0-result case.
 */

export type InFlightWorkflowsStripProps = {
  /** Fired when the user clicks a card. */
  onResume: (session: WorkflowSession) => void;
};

type ActiveRow = {
  session: WorkflowSession;
  conversation_preview: string;
};

const PREVIEW_MAX = 80;

/**
 * Bridge from a `workflowPalette` token to the `AssistantIconTile` palette
 * key. Kept local because the source-of-truth palette tokens (SPEC §13) are
 * intentionally distinct from the tile primitive's category palette.
 */
const WORKFLOW_PALETTE_TO_TILE_KEY: Record<
  string,
  'cowork' | 'write' | 'sales' | 'launch' | 'research' | 'finance' | 'dev'
> = {
  'business-ops': 'cowork',
  violet: 'write',
  emerald: 'dev',
  rose: 'launch',
  blue: 'research',
  amber: 'finance',
  slate: 'cowork',
  orange: 'cowork',
};

const formatRelativeAge = (updatedAt: number, now: number): string => {
  const diffMs = Math.max(0, now - updatedAt);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
};

const truncatePreview = (raw: string): string => {
  if (raw.length <= PREVIEW_MAX) return raw;
  return `${raw.slice(0, PREVIEW_MAX)}…`;
};

const resolveTileKey = (
  category: string | null
): 'cowork' | 'write' | 'sales' | 'launch' | 'research' | 'finance' | 'dev' => {
  const palette = resolveWorkflowPalette(category);
  return WORKFLOW_PALETTE_TO_TILE_KEY[palette] ?? 'cowork';
};

export const InFlightWorkflowsStrip: React.FC<InFlightWorkflowsStripProps> = ({ onResume }) => {
  const [rows, setRows] = useState<ActiveRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await ipcBridge.workflow.findAllActive.invoke({ limit: 3 });
        if (cancelled) return;
        setRows(result?.sessions ?? []);
      } catch {
        if (cancelled) return;
        // Honest degradation: treat fetch failure as zero in-flight workflows
        // rather than surfacing an error state on the launchpad.
        setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Loading flash + zero-result case both render nothing.
  if (rows === null || rows.length === 0) {
    return null;
  }

  const now = Date.now();

  return (
    <div className={styles.root} data-testid='inflight-workflows-strip'>
      <div className={styles.heading}>In-flight workflows</div>
      <div className={styles.row}>
        {rows.map(({ session, conversation_preview }) => {
          const tileKey = resolveTileKey(session.category);
          const preview = truncatePreview(conversation_preview ?? '');
          return (
            <button
              key={session.id}
              type='button'
              className={styles.card}
              onClick={() => onResume(session)}
              data-testid='inflight-workflow-card'
              aria-label={`Resume workflow ${session.workflow_title}, step ${session.current_step} of ${session.total_steps}`}
            >
              <AssistantIconTile paletteKey={tileKey} size='sm'>
                <Workflow />
              </AssistantIconTile>
              <div className={styles.body}>
                <div className={styles.title}>{session.workflow_title}</div>
                <div className={styles.meta}>
                  <span>
                    Step {session.current_step} of {session.total_steps}
                  </span>
                  <span className={styles.metaSep}>·</span>
                  <span>{formatRelativeAge(session.updated_at, now)}</span>
                </div>
                {preview.length > 0 && (
                  <div className={styles.preview} data-testid='inflight-workflow-preview'>
                    {preview}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default InFlightWorkflowsStrip;
