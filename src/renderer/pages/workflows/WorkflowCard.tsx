/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WorkflowCard - single grid tile on the Workflows page. Mirrors the
 * AssistantCard hover affordance (border + shadow lift on Forge Orange)
 * so the two Workspace pages feel like siblings. Source pill on top,
 * description clamped so cards stay even-height in a responsive grid.
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SkillIndexEntry } from '@/common/types/skillTypes';
import { toDisplayName } from '@renderer/pages/settings/SkillsSettings/displayName';
import styles from './WorkflowCard.module.css';

interface WorkflowCardProps {
  entry: SkillIndexEntry;
  onClick: (entry: SkillIndexEntry) => void;
  /** When true, the card renders with the Featured tier accent. */
  featured?: boolean;
}

function sourceLabel(entry: SkillIndexEntry, t: TFunction): { label: string; bg: string } {
  // Hand-mapped to the same source palette used on the Skills page so the
  // two views stay visually consistent when a user moves between them.
  // Forge Orange for `wayland-library` (the headline source) so the pill
  // reads as on-brand rather than competing with Standing Companies.
  // Labels reuse the Skills page source keys ('Дархай сан' pattern) so the
  // two views stay textually consistent too.
  switch (entry.source) {
    case 'wayland-library':
      return {
        label: t('skills.filters.source.wayland-library', { defaultValue: 'Darhai library' }),
        bg: 'rgb(var(--primary-6) / 0.16)',
      };
    case 'team':
      return {
        label: entry.sourceLabel ?? t('skills.filters.source.team', { defaultValue: 'Team' }),
        bg: 'rgba(33,150,243,0.14)',
      };
    case 'user':
      return { label: 'My workflows', bg: 'rgba(76,175,80,0.16)' };
    case 'imported':
      return { label: t('skills.filters.source.imported', { defaultValue: 'Imported' }), bg: 'rgba(233,164,14,0.18)' };
    case 'cli-discovered':
      return { label: entry.sourceLabel ?? 'CLI', bg: 'rgba(0,188,212,0.18)' };
    default:
      return { label: entry.source, bg: 'var(--color-fill-3)' };
  }
}

const WorkflowCard: React.FC<WorkflowCardProps> = ({ entry, onClick, featured = false }) => {
  const { t } = useTranslation();
  const handleClick = useCallback(() => onClick(entry), [onClick, entry]);
  const src = sourceLabel(entry, t);
  const className = featured ? `${styles.card} ${styles.cardFeatured}` : styles.card;

  return (
    <button
      type='button'
      onClick={handleClick}
      className={className}
      data-testid='workflow-card'
      data-workflow-name={entry.name}
    >
      {/* Featured pill - mirrors the 'STANDING' badge on Standing
          Companies cards (Teams page), corner-anchored so the curated
          tier reads at a glance. */}
      {featured && (
        <span className={styles.featuredBadge}>
          <span className={styles.featuredBadgeDot} aria-hidden='true' />
          Featured
        </span>
      )}
      <div className={styles.header}>
        <div className={styles.body}>
          <div className={styles.titleRow}>
            <span
              className={styles.title}
              title={entry.title ?? toDisplayName(entry.name)}
              style={{ display: 'flex', alignItems: 'center' }}
            >
              {featured && <span className={styles.titleDot} aria-hidden='true' />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {entry.title ?? toDisplayName(entry.name)}
              </span>
            </span>
            <span className={styles.pill} style={{ background: src.bg }}>
              {src.label}
            </span>
          </div>
          <div className={styles.description}>
            {entry.description || 'No description provided.'}
          </div>
        </div>
      </div>
    </button>
  );
};

export default WorkflowCard;
