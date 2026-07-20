/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import classNames from 'classnames';
import type { CalendarOccurrence } from '@/common/types/calendar';
import { formatDay, formatTime } from '../calendarUtils';
import styles from './AgendaList.module.css';

type AgendaListProps = {
  occurrences: CalendarOccurrence[];
  /** Reference "now", epoch-ms; occurrences ending before this are hidden. */
  nowMs: number;
  onSelectEvent: (occurrence: CalendarOccurrence) => void;
};

const colorClass = (color?: string): string | undefined => {
  switch (color) {
    case 'red':
      return styles.colorRed;
    case 'orange':
      return styles.colorOrange;
    case 'yellow':
      return styles.colorYellow;
    case 'green':
      return styles.colorGreen;
    case 'blue':
      return styles.colorBlue;
    case 'purple':
      return styles.colorPurple;
    default:
      return undefined;
  }
};

const AgendaList: React.FC<AgendaListProps> = ({ occurrences, nowMs, onSelectEvent }) => {
  const { t } = useTranslation();

  // Upcoming = occurrences that have not yet ended, soonest first.
  const upcoming = useMemo(
    () =>
      occurrences
        .filter((occ) => occ.occurrenceEndMs > nowMs)
        .toSorted((a, b) => a.occurrenceStartMs - b.occurrenceStartMs),
    [occurrences, nowMs]
  );

  if (upcoming.length === 0) {
    return (
      <div className={styles.empty} data-testid='calendar-agenda-empty'>
        {t('calendar.agenda.empty')}
      </div>
    );
  }

  return (
    <div className={styles.list} data-testid='calendar-agenda'>
      {upcoming.map((occ) => (
        <div
          key={`${occ.seriesId}:${occ.occurrenceStartMs}`}
          className={classNames(styles.row, colorClass(occ.color))}
          onClick={() => onSelectEvent(occ)}
          data-testid='calendar-agenda-row'
        >
          <div className={styles.when}>
            <span className={styles.whenDate}>{formatDay(occ.occurrenceStartMs)}</span>
            <span className={styles.whenTime}>
              {occ.allDay ? t('calendar.agenda.allDay') : formatTime(occ.occurrenceStartMs)}
            </span>
          </div>
          <div className={styles.body}>
            <span className={styles.title}>{occ.title || t('calendar.composer.titlePlaceholder')}</span>
            {occ.location ? (
              <span className={styles.location}>
                <MapPin size={12} /> {occ.location}
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
};

export default AgendaList;
