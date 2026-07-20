/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import type { Note } from '@/common/types/notes';
import NoteCard from './NoteCard';
import styles from './NotesList.module.css';

type NotesListProps = {
  notes: Note[];
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onTogglePin: (noteId: string) => void;
  onToggleArchive: (noteId: string) => void;
  onToggleItem: (noteId: string, index: number) => void;
};

/** Presentational masonry-ish grid of note cards (pinned already sorted first). */
const NotesList: React.FC<NotesListProps> = ({
  notes,
  onEdit,
  onDelete,
  onTogglePin,
  onToggleArchive,
  onToggleItem,
}) => {
  return (
    <div className={styles.grid} data-testid='notes-list'>
      {notes.map((note) => (
        <NoteCard
          key={note.id}
          note={note}
          onEdit={onEdit}
          onDelete={onDelete}
          onTogglePin={onTogglePin}
          onToggleArchive={onToggleArchive}
          onToggleItem={onToggleItem}
        />
      ))}
    </div>
  );
};

export default NotesList;
