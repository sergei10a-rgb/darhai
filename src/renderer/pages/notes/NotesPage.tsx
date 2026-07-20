/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Notification, Switch } from '@arco-design/web-react';
import { NotebookPen, Plus } from 'lucide-react';
import { ipcBridge } from '@/common';
import PageShell from '@renderer/components/layout/PageShell';
import type { Note } from '@/common/types/notes';
import { useNotes } from './useNotes';
import NotesList from './components/NotesList';
import NoteComposerModal, { type NoteComposerSubmit } from './components/NoteComposerModal';
import styles from './Notes.module.css';

const NotesPage: React.FC = () => {
  const { t } = useTranslation();
  const [showArchived, setShowArchived] = useState(false);
  const { notes, isLoading, createNote, updateNote, deleteNote, togglePin, toggleArchive, toggleItem } =
    useNotes(showArchived);

  const [composerOpen, setComposerOpen] = useState(false);
  const [editing, setEditing] = useState<Note | null>(null);

  // Surface a due-date reminder as an in-app toast (native OS notification is
  // fired separately by the main-process scanner).
  useEffect(() => {
    const unsubscribe = ipcBridge.note.onReminderFired.on((event) => {
      Notification.info({
        title: event.title || t('notes.reminderToast.title'),
        content: event.body,
      });
    });
    return () => unsubscribe();
  }, [t]);

  const openCreate = (): void => {
    setEditing(null);
    setComposerOpen(true);
  };

  const openEdit = (note: Note): void => {
    setEditing(note);
    setComposerOpen(true);
  };

  const handleSubmit = async (values: NoteComposerSubmit): Promise<void> => {
    if (editing) {
      await updateNote(editing.id, {
        title: values.title ?? '',
        content: values.content ?? '',
        items: values.items ?? [],
        noteType: values.noteType,
        color: values.color ?? '',
        label: values.label ?? '',
        dueDateMs: values.dueDateMs ?? null,
        repeat: values.repeat,
      });
    } else {
      await createNote(values);
    }
    setComposerOpen(false);
    setEditing(null);
  };

  const actions = (
    <div className={styles.headerActions}>
      <label className={styles.archiveToggle}>
        <Switch size='small' checked={showArchived} onChange={setShowArchived} data-testid='notes-archived-switch' />
        <span>{t('notes.showArchived')}</span>
      </label>
      <Button type='primary' icon={<Plus size={16} />} onClick={openCreate} data-testid='notes-new'>
        {t('notes.newNote')}
      </Button>
    </div>
  );

  const showEmpty = !isLoading && notes.length === 0;

  return (
    <PageShell
      title={t('notes.pageTitle')}
      icon={<NotebookPen size={20} />}
      subtitle={t('notes.description')}
      countLabel={t('notes.footer.count', { count: notes.length })}
      actions={actions}
      width='full'
      testId='notes-page'
    >
      {showEmpty ? (
        <div className={styles.empty} data-testid='notes-empty'>
          <NotebookPen size={40} className={styles.emptyIcon} />
          <span className={styles.emptyTitle}>{t('notes.empty.title')}</span>
          <span className={styles.emptyHint}>{t('notes.empty.hint')}</span>
        </div>
      ) : (
        <NotesList
          notes={notes}
          onEdit={openEdit}
          onDelete={deleteNote}
          onTogglePin={togglePin}
          onToggleArchive={toggleArchive}
          onToggleItem={toggleItem}
        />
      )}

      <NoteComposerModal
        visible={composerOpen}
        note={editing}
        onCancel={() => {
          setComposerOpen(false);
          setEditing(null);
        }}
        onSubmit={handleSubmit}
      />
    </PageShell>
  );
};

export default NotesPage;
