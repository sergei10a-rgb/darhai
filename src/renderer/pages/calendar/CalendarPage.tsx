/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Notification, Radio } from '@arco-design/web-react';
import { CalendarDays, CalendarPlus } from 'lucide-react';
import { ipcBridge } from '@/common';
import PageShell from '@renderer/components/layout/PageShell';
import type { CalendarEvent, CalendarOccurrence } from '@/common/types/calendar';
import { useCalendar } from './useCalendar';
import MonthView from './components/MonthView';
import AgendaList from './components/AgendaList';
import EventComposerModal, { type EventComposerSubmit } from './components/EventComposerModal';
import styles from './Calendar.module.css';

// secondary: MVP ships Month + Agenda. Deferred (not built here): a WeekView
// time-grid with drag-to-create, NL quick-add (LLM), and ICS import/export +
// CalDAV two-way sync from the calendar settings panel.
type CalendarView = 'month' | 'agenda';

const CalendarPage: React.FC = () => {
  const { t } = useTranslation();
  const [anchorMs, setAnchorMs] = useState<number>(() => Date.now());
  const [view, setView] = useState<CalendarView>('month');
  const { occurrences, isLoading, createEvent, updateEvent, deleteEvent } = useCalendar(anchorMs);

  const [composerOpen, setComposerOpen] = useState(false);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [presetDayMs, setPresetDayMs] = useState<number | null>(null);

  // Surface a lead-time reminder as an in-app toast (native OS notification is
  // fired separately by the main-process scanner).
  useEffect(() => {
    const unsubscribe = ipcBridge.calendar.onReminderFired.on((event) => {
      Notification.info({
        title: event.title || t('calendar.reminderToast.title'),
        content: event.body,
      });
    });
    return () => unsubscribe();
  }, [t]);

  const openCreate = (): void => {
    setEditing(null);
    setPresetDayMs(null);
    setComposerOpen(true);
  };

  const openCreateOnDay = (dayMs: number): void => {
    setEditing(null);
    setPresetDayMs(dayMs);
    setComposerOpen(true);
  };

  const openEdit = (occurrence: CalendarOccurrence): void => {
    // The occurrence carries the series row fields (id === seriesId), so editing
    // it targets the whole series (per-occurrence exceptions are deferred).
    setEditing(occurrence);
    setPresetDayMs(null);
    setComposerOpen(true);
  };

  const closeComposer = (): void => {
    setComposerOpen(false);
    setEditing(null);
    setPresetDayMs(null);
  };

  const handleSubmit = async (values: EventComposerSubmit): Promise<void> => {
    if (editing) {
      await updateEvent(editing.id, {
        title: values.title ?? '',
        description: values.description ?? '',
        location: values.location ?? '',
        startMs: values.startMs,
        endMs: values.endMs,
        allDay: values.allDay,
        rrule: values.rrule ?? null,
        reminderLeadMs: values.reminderLeadMs ?? null,
        color: values.color ?? '',
      });
    } else {
      await createEvent({
        title: values.title,
        description: values.description,
        location: values.location,
        startMs: values.startMs,
        endMs: values.endMs,
        allDay: values.allDay,
        rrule: values.rrule,
        reminderLeadMs: values.reminderLeadMs ?? undefined,
        color: values.color,
      });
    }
    closeComposer();
  };

  const handleDelete = async (eventId: string): Promise<void> => {
    await deleteEvent(eventId);
    closeComposer();
  };

  const actions = (
    <div className={styles.headerActions}>
      <Radio.Group
        type='button'
        size='small'
        value={view}
        onChange={(value) => setView(value as CalendarView)}
        data-testid='calendar-view-switch'
      >
        <Radio value='month'>{t('calendar.view.month')}</Radio>
        <Radio value='agenda'>{t('calendar.view.agenda')}</Radio>
      </Radio.Group>
      <Button onClick={() => setAnchorMs(Date.now())} data-testid='calendar-today'>
        {t('calendar.today')}
      </Button>
      <Button type='primary' icon={<CalendarPlus size={16} />} onClick={openCreate} data-testid='calendar-new'>
        {t('calendar.newEvent')}
      </Button>
    </div>
  );

  const showEmpty = !isLoading && occurrences.length === 0;

  return (
    <PageShell
      title={t('calendar.pageTitle')}
      icon={<CalendarDays size={20} />}
      subtitle={t('calendar.description')}
      countLabel={t('calendar.footer.count', { count: occurrences.length })}
      actions={actions}
      width='full'
      testId='calendar-page'
    >
      <div className={styles.body}>
        {showEmpty ? (
          <div className={styles.empty} data-testid='calendar-empty'>
            <CalendarDays size={40} className={styles.emptyIcon} />
            <span className={styles.emptyTitle}>{t('calendar.empty.title')}</span>
            <span className={styles.emptyHint}>{t('calendar.empty.hint')}</span>
          </div>
        ) : null}

        {view === 'month' ? (
          <MonthView
            occurrences={occurrences}
            anchorMs={anchorMs}
            onMonthChange={setAnchorMs}
            onSelectDay={openCreateOnDay}
            onSelectEvent={openEdit}
          />
        ) : (
          <AgendaList occurrences={occurrences} nowMs={Date.now()} onSelectEvent={openEdit} />
        )}
      </div>

      <EventComposerModal
        visible={composerOpen}
        event={editing}
        presetDayMs={presetDayMs}
        onCancel={closeComposer}
        onSubmit={handleSubmit}
        onDelete={handleDelete}
      />
    </PageShell>
  );
};

export default CalendarPage;
