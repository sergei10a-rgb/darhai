/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WorkflowCard — single grid tile on the Workflows page. Mirrors the
 * compact aesthetic of the Skills page row but laid out as a card so a
 * grid scans quickly. Title + source pill on top, description clamped to
 * three lines so cards stay even-height.
 */

import { Workflow as WorkflowIcon } from 'lucide-react';
import React, { useCallback } from 'react';
import type { SkillIndexEntry } from '@/common/types/skillTypes';
import { toDisplayName } from '@renderer/pages/settings/SkillsSettings/displayName';

interface WorkflowCardProps {
  entry: SkillIndexEntry;
  onClick: (entry: SkillIndexEntry) => void;
}

function sourceLabel(entry: SkillIndexEntry): { label: string; color: string } {
  // Hand-mapped to the same source palette used on the Skills page so the
  // two views stay visually consistent when a user moves between them.
  switch (entry.source) {
    case 'wayland-library':
      return { label: 'Wayland Library', color: 'rgba(var(--primary-6),0.12)' };
    case 'team':
      return { label: entry.sourceLabel ?? 'Wayland Teams', color: 'rgba(33,150,243,0.14)' };
    case 'user':
      return { label: 'My workflows', color: 'rgba(76,175,80,0.16)' };
    case 'imported':
      return { label: 'Imported', color: 'rgba(233,164,14,0.18)' };
    case 'cli-discovered':
      return { label: entry.sourceLabel ?? 'CLI', color: 'rgba(0,188,212,0.18)' };
    default:
      return { label: entry.source, color: 'var(--fill-2)' };
  }
}

const WorkflowCard: React.FC<WorkflowCardProps> = ({ entry, onClick }) => {
  const handleClick = useCallback(() => onClick(entry), [onClick, entry]);
  const src = sourceLabel(entry);

  return (
    <button
      type='button'
      onClick={handleClick}
      className='text-left p-14px rd-10px cursor-pointer transition-colors'
      style={{
        background: 'var(--fill-1)',
        border: '1px solid var(--border-1)',
      }}
    >
      <div className='flex items-start gap-10px'>
        <div
          className='shrink-0 w-32px h-32px flex items-center justify-center rd-8px'
          style={{ background: 'rgba(var(--primary-6),0.12)', color: 'var(--primary)' }}
        >
          <WorkflowIcon size={18} />
        </div>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-6px flex-wrap'>
            <span
              className='text-14px font-semibold truncate'
              style={{ color: 'var(--text-primary)' }}
            >
              {toDisplayName(entry.name)}
            </span>
            <span
              className='text-10px px-6px py-1px rd-4px uppercase tracking-wide'
              style={{ background: src.color, color: 'var(--text-secondary)' }}
            >
              {src.label}
            </span>
          </div>
          <div
            className='text-12px mt-6px overflow-hidden'
            style={{
              color: 'var(--text-secondary)',
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 3,
            }}
          >
            {entry.description || 'No description provided.'}
          </div>
        </div>
      </div>
    </button>
  );
};

export default WorkflowCard;
