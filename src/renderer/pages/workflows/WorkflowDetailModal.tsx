/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WorkflowDetailModal — opens when a WorkflowCard is clicked.
 *
 * Surfaces the workflow's name + description + (when present) the SKILL.md
 * body so the user can see exactly what they're about to run. Two CTAs:
 *
 *   - **Launch** — start a new chat with the workflow loaded as the
 *     agent's first directive. Engine picker comes in a follow-up; for
 *     this first cut the button shows a placeholder explaining the wiring
 *     is in flight.
 *   - **Schedule** — opens the existing Create Scheduled Task modal with
 *     this workflow pre-filled. Wired in step #6 of the split — until
 *     that lands the button shows a placeholder pointing at the
 *     Scheduled Tasks sidebar entry.
 */

import { Button, Modal, Spin } from '@arco-design/web-react';
import { Calendar, Rocket } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { SkillIndexEntry } from '@/common/types/skillTypes';
import { toDisplayName } from '@renderer/pages/settings/SkillsSettings/displayName';

interface WorkflowDetailModalProps {
  entry: SkillIndexEntry | null;
  onClose: () => void;
}

const WorkflowDetailModal: React.FC<WorkflowDetailModalProps> = ({ entry, onClose }) => {
  const { t } = useTranslation(undefined, { keyPrefix: 'workflows' });
  const [body, setBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!entry) {
      setBody(null);
      return;
    }
    setLoading(true);
    // The Skills bridge already exposes a path-aware loader via the scan
    // endpoint; reusing it would be heavier than needed. For the detail
    // modal we lean on the report-style getter for now — it returns null
    // when no body is on disk, which is a sensible empty state.
    void ipcBridge.skills.getReport
      .invoke({ name: entry.name })
      .then(() => {
        // The report-only endpoint doesn't return the body. Until a body
        // endpoint exists, surface the description and a hint that
        // launch/schedule consume the body server-side.
        setBody(null);
      })
      .finally(() => setLoading(false));
  }, [entry]);

  const handleLaunch = () => {
    // eslint-disable-next-line no-alert
    window.alert(
      t(
        'launch.placeholder',
        'Launch wiring is in flight. Soon you will pick an engine (Wayland Core / Gemini / Claude / Codex), and the workflow will load as the agent\'s first directive in a fresh chat.',
      ),
    );
  };

  const handleSchedule = () => {
    // eslint-disable-next-line no-alert
    window.alert(
      t(
        'schedule.placeholder',
        'Schedule wiring lands in the next pass — the Create Scheduled Task modal will gain a "From workflow" tab and open here pre-filled with this workflow. For now, open Scheduled Tasks in the sidebar and paste the workflow as the prompt.',
      ),
    );
  };

  return (
    <Modal
      visible={entry !== null}
      onCancel={onClose}
      footer={null}
      autoFocus={false}
      style={{ width: 640 }}
      title={entry ? toDisplayName(entry.name) : ''}
    >
      {entry ? (
        <div className='flex flex-col gap-16px'>
          <p
            className='text-13px m-0'
            style={{ color: 'var(--text-secondary)' }}
          >
            {entry.description || t('noDescription', 'No description provided.')}
          </p>

          <div
            className='p-12px rd-8px text-12px'
            style={{
              background: 'var(--fill-1)',
              border: '1px solid var(--border-1)',
              color: 'var(--text-secondary)',
            }}
          >
            {loading ? (
              <Spin size={16} />
            ) : (
              <>
                <div className='font-semibold mb-4px' style={{ color: 'var(--text-primary)' }}>
                  {t('whatHappens', 'When you launch this')}
                </div>
                {body
                  ? body.slice(0, 600) + (body.length > 600 ? '…' : '')
                  : t(
                      'bodyFallback',
                      'The agent loads this workflow as its first directive and walks you through it step by step. You can interrupt or change direction at any point.',
                    )}
              </>
            )}
          </div>

          <div className='flex items-center justify-end gap-8px pt-8px'>
            <Button icon={<Calendar size={14} />} onClick={handleSchedule}>
              {t('actions.schedule', 'Schedule')}
            </Button>
            <Button type='primary' icon={<Rocket size={14} />} onClick={handleLaunch}>
              {t('actions.launch', 'Launch now')}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
};

export default WorkflowDetailModal;
