/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, DatePicker, Input, Modal, Popconfirm, Select, Switch } from '@arco-design/web-react';
import type { CalendarEvent } from '@/common/types/calendar';
import {
  COLOR_KEYS,
  RECURRENCE_PRESETS,
  REMINDER_OPTIONS,
  presetToRrule,
  reminderKeyFromMs,
  rruleToPreset,
  type RecurrencePreset,
} from '../calendarUtils';
import styles from './EventComposerModal.module.css';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Values emitted on submit; the page maps these to create / update params. */
export type EventComposerSubmit = {
  title?: string;
  description?: string;
  location?: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  rrule?: string;
  /** null clears the reminder; a number sets it. */
  reminderLeadMs?: number | null;
  color?: string;
};

type EventComposerModalProps = {
  visible: boolean;
  /** When set, the modal edits this event's series; otherwise it creates a new one. */
  event?: CalendarEvent | null;
  /** Preselected day (epoch-ms, local midnight) for a fresh event; null = now. */
  presetDayMs?: number | null;
  onCancel: () => void;
  onSubmit: (values: EventComposerSubmit) => Promise<void>;
  onDelete?: (eventId: string) => Promise<void>;
};

/** Local start-of-day for an epoch-ms. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Default start for a fresh event: the preset day at 09:00, else the next hour. */
function defaultStart(presetDayMs: number | null | undefined): number {
  if (presetDayMs != null) return startOfDay(presetDayMs) + 9 * HOUR;
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
}

const EventComposerModal: React.FC<EventComposerModalProps> = ({
  visible,
  event,
  presetDayMs,
  onCancel,
  onSubmit,
  onDelete,
}) => {
  const { t } = useTranslation();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [startMs, setStartMs] = useState<number>(() => defaultStart(presetDayMs));
  const [endMs, setEndMs] = useState<number>(() => defaultStart(presetDayMs) + HOUR);
  const [repeat, setRepeat] = useState<RecurrencePreset>('none');
  const [reminderKey, setReminderKey] = useState<string>('none');
  const [color, setColor] = useState<string>('none');
  const [saving, setSaving] = useState(false);

  // Reset / hydrate the form each time the modal opens.
  useEffect(() => {
    if (!visible) return;
    if (event) {
      setTitle(event.title ?? '');
      setDescription(event.description ?? '');
      setLocation(event.location ?? '');
      setAllDay(event.allDay);
      setStartMs(event.startMs);
      setEndMs(event.endMs);
      setRepeat(rruleToPreset(event.rrule));
      setReminderKey(reminderKeyFromMs(event.reminderLeadMs));
      setColor(event.color ?? 'none');
    } else {
      const start = defaultStart(presetDayMs);
      setTitle('');
      setDescription('');
      setLocation('');
      setAllDay(false);
      setStartMs(start);
      setEndMs(start + HOUR);
      setRepeat('none');
      setReminderKey('none');
      setColor('none');
    }
    setSaving(false);
  }, [visible, event, presetDayMs]);

  const isEdit = Boolean(event);

  const handleStartChange = (value: number): void => {
    setStartMs(value);
    // Keep the end after the start (preserve the current duration when possible).
    if (value >= endMs) setEndMs(value + (allDay ? DAY : HOUR));
  };

  const handleSubmit = async (): Promise<void> => {
    setSaving(true);
    try {
      let start = startMs;
      let end = endMs;
      if (allDay) {
        start = startOfDay(start);
        end = Math.max(startOfDay(end) + DAY, start + DAY);
      } else if (end <= start) {
        end = start + HOUR;
      }
      const reminder = REMINDER_OPTIONS.find((o) => o.key === reminderKey);
      await onSubmit({
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        location: location.trim() || undefined,
        startMs: start,
        endMs: end,
        allDay,
        rrule: presetToRrule(repeat, start),
        reminderLeadMs: reminder ? reminder.ms : null,
        color: color === 'none' ? undefined : color,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isEdit ? t('calendar.composer.editTitle') : t('calendar.composer.createTitle')}
      visible={visible}
      onCancel={onCancel}
      footer={null}
      unmountOnExit
      maskClosable={false}
      autoFocus={false}
    >
      <div className={styles.form}>
        <Input
          value={title}
          onChange={setTitle}
          placeholder={t('calendar.composer.titlePlaceholder')}
          data-testid='event-composer-title'
        />

        <label className={styles.allDayRow}>
          <Switch size='small' checked={allDay} onChange={setAllDay} data-testid='event-composer-allday' />
          <span>{t('calendar.composer.allDay')}</span>
        </label>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('calendar.composer.starts')}</span>
            <DatePicker
              showTime={!allDay}
              value={startMs}
              onChange={(_, date) => {
                if (date) handleStartChange(date.valueOf());
              }}
              placeholder={t('calendar.composer.startPlaceholder')}
              style={{ width: '100%' }}
              data-testid='event-composer-start'
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('calendar.composer.ends')}</span>
            <DatePicker
              showTime={!allDay}
              value={endMs}
              onChange={(_, date) => {
                if (date) setEndMs(date.valueOf());
              }}
              placeholder={t('calendar.composer.endPlaceholder')}
              style={{ width: '100%' }}
              data-testid='event-composer-end'
            />
          </label>
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('calendar.composer.repeatLabel')}</span>
            <Select
              value={repeat}
              onChange={(value) => setRepeat(value as RecurrencePreset)}
              data-testid='event-composer-repeat'
            >
              {RECURRENCE_PRESETS.map((key) => (
                <Select.Option key={key} value={key}>
                  {t(`calendar.repeat.${key}`)}
                </Select.Option>
              ))}
            </Select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('calendar.composer.reminderLabel')}</span>
            <Select value={reminderKey} onChange={setReminderKey} data-testid='event-composer-reminder'>
              {REMINDER_OPTIONS.map((option) => (
                <Select.Option key={option.key} value={option.key}>
                  {t(`calendar.remind.${option.key}`)}
                </Select.Option>
              ))}
            </Select>
          </label>
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('calendar.composer.colorLabel')}</span>
            <Select value={color} onChange={setColor} data-testid='event-composer-color'>
              {COLOR_KEYS.map((key) => (
                <Select.Option key={key} value={key}>
                  {t(`calendar.color.${key}`)}
                </Select.Option>
              ))}
            </Select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('calendar.composer.locationLabel')}</span>
            <Input
              value={location}
              onChange={setLocation}
              placeholder={t('calendar.composer.locationPlaceholder')}
              data-testid='event-composer-location'
            />
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('calendar.composer.descriptionLabel')}</span>
          <Input.TextArea
            value={description}
            onChange={setDescription}
            placeholder={t('calendar.composer.descriptionPlaceholder')}
            autoSize={{ minRows: 2, maxRows: 6 }}
            data-testid='event-composer-description'
          />
        </label>

        <div className={styles.actions}>
          {isEdit && onDelete && event ? (
            <Popconfirm
              title={t('calendar.deleteConfirm.title')}
              content={t('calendar.deleteConfirm.content')}
              okText={t('calendar.deleteConfirm.ok')}
              cancelText={t('calendar.deleteConfirm.cancel')}
              onOk={() => onDelete(event.id)}
            >
              <Button status='danger' data-testid='event-composer-delete'>
                {t('calendar.composer.delete')}
              </Button>
            </Popconfirm>
          ) : (
            <span />
          )}
          <div className={styles.actionsRight}>
            <Button onClick={onCancel}>{t('calendar.composer.cancel')}</Button>
            <Button type='primary' loading={saving} onClick={handleSubmit} data-testid='event-composer-save'>
              {t('calendar.composer.save')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default EventComposerModal;
