/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, DatePicker, Input, Modal, Radio, Select } from '@arco-design/web-react';
import { Plus, Trash2 } from 'lucide-react';
import type { CreateNoteParams, Note, NoteChecklistItem, NoteRepeat, NoteType } from '@/common/types/notes';
import styles from './NoteComposerModal.module.css';

const COLOR_KEYS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
const REPEAT_KEYS: NoteRepeat[] = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

export type NoteComposerSubmit = Omit<CreateNoteParams, 'userId'>;

type NoteComposerModalProps = {
  visible: boolean;
  /** When set, the modal edits this note; otherwise it creates a new one. */
  note?: Note | null;
  onCancel: () => void;
  onSubmit: (values: NoteComposerSubmit) => Promise<void>;
};

const NoteComposerModal: React.FC<NoteComposerModalProps> = ({ visible, note, onCancel, onSubmit }) => {
  const { t } = useTranslation();

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('note');
  const [items, setItems] = useState<NoteChecklistItem[]>([]);
  const [color, setColor] = useState<string>('none');
  const [label, setLabel] = useState('');
  const [dueDateMs, setDueDateMs] = useState<number | undefined>(undefined);
  const [repeat, setRepeat] = useState<NoteRepeat>('none');
  const [saving, setSaving] = useState(false);

  // Reset / hydrate the form each time the modal opens.
  useEffect(() => {
    if (!visible) return;
    setTitle(note?.title ?? '');
    setContent(note?.content ?? '');
    setNoteType(note?.noteType ?? 'note');
    setItems(note?.items ? note.items.map((item) => ({ ...item })) : []);
    setColor(note?.color ?? 'none');
    setLabel(note?.label ?? '');
    setDueDateMs(note?.dueDateMs);
    setRepeat(note?.repeat ?? 'none');
    setSaving(false);
  }, [visible, note]);

  const isEdit = Boolean(note);

  const updateItemText = (index: number, text: string): void => {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, text } : item)));
  };

  const removeItem = (index: number): void => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const addItem = (): void => {
    setItems((prev) => [...prev, { text: '', done: false }]);
  };

  const handleSubmit = async (): Promise<void> => {
    setSaving(true);
    try {
      const cleanItems = noteType === 'todo' ? items.filter((item) => item.text.trim().length > 0) : undefined;
      await onSubmit({
        title: title.trim() || undefined,
        content: content.trim() || undefined,
        items: cleanItems,
        noteType,
        color: color === 'none' ? undefined : color,
        label: label.trim() || undefined,
        dueDateMs,
        repeat,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isEdit ? t('notes.composer.editTitle') : t('notes.composer.createTitle')}
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
          placeholder={t('notes.composer.titlePlaceholder')}
          data-testid='note-composer-title'
        />

        <Radio.Group
          type='button'
          value={noteType}
          onChange={(value) => setNoteType(value as NoteType)}
          data-testid='note-composer-type'
        >
          <Radio value='note'>{t('notes.composer.typeNote')}</Radio>
          <Radio value='todo'>{t('notes.composer.typeTodo')}</Radio>
        </Radio.Group>

        {noteType === 'note' ? (
          <Input.TextArea
            value={content}
            onChange={setContent}
            placeholder={t('notes.composer.contentPlaceholder')}
            autoSize={{ minRows: 3, maxRows: 8 }}
            data-testid='note-composer-content'
          />
        ) : (
          <div className={styles.checklist}>
            <span className={styles.fieldLabel}>{t('notes.composer.checklistLabel')}</span>
            {items.map((item, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={index} className={styles.checklistRow}>
                <Input
                  value={item.text}
                  onChange={(value) => updateItemText(index, value)}
                  placeholder={t('notes.composer.itemPlaceholder')}
                />
                <Button
                  type='text'
                  icon={<Trash2 size={15} />}
                  onClick={() => removeItem(index)}
                  aria-label={t('notes.card.delete')}
                />
              </div>
            ))}
            <Button type='text' icon={<Plus size={15} />} onClick={addItem} className={styles.addItem}>
              {t('notes.composer.addItem')}
            </Button>
          </div>
        )}

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('notes.composer.colorLabel')}</span>
            <Select value={color} onChange={setColor} data-testid='note-composer-color'>
              {COLOR_KEYS.map((key) => (
                <Select.Option key={key} value={key}>
                  {t(`notes.color.${key}`)}
                </Select.Option>
              ))}
            </Select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('notes.composer.labelLabel')}</span>
            <Input value={label} onChange={setLabel} placeholder={t('notes.composer.labelPlaceholder')} />
          </label>
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('notes.composer.dueLabel')}</span>
            <DatePicker
              showTime
              value={dueDateMs}
              onChange={(_, date) => setDueDateMs(date ? date.valueOf() : undefined)}
              placeholder={t('notes.composer.duePlaceholder')}
              style={{ width: '100%' }}
              data-testid='note-composer-due'
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('notes.composer.repeatLabel')}</span>
            <Select
              value={repeat}
              onChange={(value) => setRepeat(value as NoteRepeat)}
              disabled={dueDateMs === undefined}
              data-testid='note-composer-repeat'
            >
              {REPEAT_KEYS.map((key) => (
                <Select.Option key={key} value={key}>
                  {t(`notes.repeat.${key}`)}
                </Select.Option>
              ))}
            </Select>
          </label>
        </div>

        <div className={styles.actions}>
          <Button onClick={onCancel}>{t('notes.composer.cancel')}</Button>
          <Button type='primary' loading={saving} onClick={handleSubmit} data-testid='note-composer-save'>
            {t('notes.composer.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default NoteComposerModal;
