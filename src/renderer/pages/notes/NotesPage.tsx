/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Message, Notification, Switch } from '@arco-design/web-react';
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

  /**
   * Run a note mutation and surface a rejection as a toast.
   *
   * Every one of these goes over the IPC bridge, which now rejects when the
   * main-process handler throws. Without this the rejection would be silent to
   * the user and land as an unhandled rejection in the console.
   */
  const runMutation = async (mutate: () => Promise<void>, failedLabel: string): Promise<void> => {
    try {
      await mutate();
    } catch (error) {
      Message.error(`${failedLabel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const openCreate = (): void => {
    setEditing(null);
    setComposerOpen(true);
  };

  const openEdit = (note: Note): void => {
    setEditing(note);
    setComposerOpen(true);
  };

  const handleSubmit = async (values: NoteComposerSubmit): Promise<void> => {
    // A rejected write must tell the user and keep the composer open with their
    // input intact - closing it would silently discard what they just typed.
    try {
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
    } catch (error) {
      Message.error(`${t('common.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`);
      return;
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
          onDelete={(noteId) => void runMutation(() => deleteNote(noteId), t('common.deleteFailed'))}
          onTogglePin={(noteId) => void runMutation(() => togglePin(noteId), t('common.saveFailed'))}
          onToggleArchive={(noteId) => void runMutation(() => toggleArchive(noteId), t('common.saveFailed'))}
          onToggleItem={(noteId, index) => void runMutation(() => toggleItem(noteId, index), t('common.saveFailed'))}
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
