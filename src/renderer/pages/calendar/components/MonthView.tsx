/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar } from '@arco-design/web-react';
import type { Dayjs } from 'dayjs';
import classNames from 'classnames';
import type { CalendarOccurrence } from '@/common/types/calendar';
import { dayKey, formatTime } from '../calendarUtils';
import styles from './MonthView.module.css';

/** Max chips rendered per day before collapsing into a "+N more" hint. */
const MAX_CHIPS_PER_DAY = 3;

type MonthViewProps = {
  /** Occurrences already expanded for the visible range. */
  occurrences: CalendarOccurrence[];
  /** Controlled visible-month anchor, epoch-ms. */
  anchorMs: number;
  /** Fired when the panel navigates to another month. */
  onMonthChange: (anchorMs: number) => void;
  /** Fired when an empty day cell is clicked (create on that day). */
  onSelectDay: (dayMs: number) => void;
  /** Fired when an event chip is clicked (edit the series). */
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

const MonthView: React.FC<MonthViewProps> = ({ occurrences, anchorMs, onMonthChange, onSelectDay, onSelectEvent }) => {
  const { t } = useTranslation();

  // Bucket occurrences by their (local) start day for O(1) cell lookup.
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarOccurrence[]>();
    for (const occ of occurrences) {
      const d = new Date(occ.occurrenceStartMs);
      const key = dayKey(d.getFullYear(), d.getMonth(), d.getDate());
      const bucket = map.get(key);
      if (bucket) bucket.push(occ);
      else map.set(key, [occ]);
    }
    return map;
  }, [occurrences]);

  const todayKey = useMemo(() => {
    const now = new Date();
    return dayKey(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  const renderCell = (current: Dayjs): React.ReactNode => {
    const key = dayKey(current.year(), current.month(), current.date());
    const dayEvents = byDay.get(key) ?? [];
    const shown = dayEvents.slice(0, MAX_CHIPS_PER_DAY);
    const overflow = dayEvents.length - shown.length;

    return (
      <div className={styles.cell} onClick={() => onSelectDay(current.valueOf())} data-testid='calendar-day-cell'>
        <span className={classNames(styles.dayNum, key === todayKey && styles.today)}>{current.date()}</span>
        <div className={styles.chips}>
          {shown.map((occ) => (
            <div
              key={`${occ.seriesId}:${occ.occurrenceStartMs}`}
              className={classNames(styles.chip, colorClass(occ.color))}
              onClick={(e) => {
                e.stopPropagation();
                onSelectEvent(occ);
              }}
              title={occ.title}
              data-testid='calendar-event-chip'
            >
              {!occ.allDay ? <span className={styles.chipTime}>{formatTime(occ.occurrenceStartMs)}</span> : null}
              <span className={styles.chipTitle}>{occ.title || t('calendar.composer.titlePlaceholder')}</span>
            </div>
          ))}
          {overflow > 0 ? <span className={styles.more}>{t('calendar.month.more', { count: overflow })}</span> : null}
        </div>
      </div>
    );
  };

  return (
    <Calendar
      panel
      mode='month'
      dayStartOfWeek={1}
      pageShowDate={anchorMs}
      dateRender={renderCell}
      onPanelChange={(date) => onMonthChange(date.valueOf())}
    />
  );
};

export default MonthView;
