/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, Popconfirm, Tag, Tooltip } from '@arco-design/web-react';
import { Archive, ArchiveRestore, Bell, Pencil, Pin, PinOff, Repeat, Trash2 } from 'lucide-react';
import classNames from 'classnames';
import type { Note } from '@/common/types/notes';
import styles from './NoteCard.module.css';

type NoteCardProps = {
  note: Note;
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onTogglePin: (noteId: string) => void;
  onToggleArchive: (noteId: string) => void;
  onToggleItem: (noteId: string, index: number) => void;
};

/** Map a note color key to its CSS-module accent class (semantic arco tokens). */
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

const NoteCard: React.FC<NoteCardProps> = ({ note, onEdit, onDelete, onTogglePin, onToggleArchive, onToggleItem }) => {
  const { t } = useTranslation();

  const items = note.items ?? [];
  const doneCount = items.filter((item) => item.done).length;
  const dueLabel = note.dueDateMs ? new Date(note.dueDateMs).toLocaleString() : null;

  return (
    <div
      className={classNames(styles.card, colorClass(note.color), note.pinned && styles.pinned)}
      data-testid='note-card'
      data-note-id={note.id}
    >
      <div className={styles.header}>
        <span className={styles.title}>{note.title || t('notes.card.untitled')}</span>
        <div className={styles.headerActions}>
          <Tooltip content={note.pinned ? t('notes.card.unpin') : t('notes.card.pin')}>
            <Button
              type='text'
              size='mini'
              icon={note.pinned ? <PinOff size={15} /> : <Pin size={15} />}
              onClick={() => onTogglePin(note.id)}
              aria-label={note.pinned ? t('notes.card.unpin') : t('notes.card.pin')}
              data-testid='note-card-pin'
            />
          </Tooltip>
          <Tooltip content={t('notes.card.edit')}>
            <Button
              type='text'
              size='mini'
              icon={<Pencil size={15} />}
              onClick={() => onEdit(note)}
              aria-label={t('notes.card.edit')}
              data-testid='note-card-edit'
            />
          </Tooltip>
          <Tooltip content={note.archived ? t('notes.card.unarchive') : t('notes.card.archive')}>
            <Button
              type='text'
              size='mini'
              icon={note.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
              onClick={() => onToggleArchive(note.id)}
              aria-label={note.archived ? t('notes.card.unarchive') : t('notes.card.archive')}
              data-testid='note-card-archive'
            />
          </Tooltip>
          <Popconfirm
            title={t('notes.deleteConfirm.title')}
            content={t('notes.deleteConfirm.content')}
            okText={t('notes.deleteConfirm.ok')}
            cancelText={t('notes.deleteConfirm.cancel')}
            onOk={() => onDelete(note.id)}
          >
            <Button
              type='text'
              size='mini'
              status='danger'
              icon={<Trash2 size={15} />}
              aria-label={t('notes.card.delete')}
              data-testid='note-card-delete'
            />
          </Popconfirm>
        </div>
      </div>

      {note.noteType === 'todo' && items.length > 0 ? (
        <ul className={styles.checklist}>
          {items.map((item, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={index} className={styles.checklistItem}>
              <Checkbox checked={item.done} onChange={() => onToggleItem(note.id, index)} data-testid='note-card-item'>
                <span className={item.done ? styles.itemDone : undefined}>{item.text}</span>
              </Checkbox>
            </li>
          ))}
        </ul>
      ) : note.content ? (
        <p className={styles.content}>{note.content}</p>
      ) : null}

      <div className={styles.footer}>
        {note.label ? <Tag size='small'>{note.label}</Tag> : null}
        {note.noteType === 'todo' && items.length > 0 ? (
          <span className={styles.meta}>
            {t('notes.card.checklistProgress', { done: doneCount, total: items.length })}
          </span>
        ) : null}
        {dueLabel ? (
          <span className={styles.due} data-testid='note-card-due'>
            <Bell size={12} />
            {dueLabel}
            {note.repeat !== 'none' ? <Repeat size={12} /> : null}
          </span>
        ) : null}
      </div>
    </div>
  );
};

export default NoteCard;
