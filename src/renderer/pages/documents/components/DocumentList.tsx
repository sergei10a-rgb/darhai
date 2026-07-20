/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@arco-design/web-react';
import { FileText, Plus, Trash2 } from 'lucide-react';
import classNames from 'classnames';
import type { DocumentEntity } from '@/common/types/documents';
import styles from '../Documents.module.css';

type DocumentListProps = {
  documents: DocumentEntity[];
  activeId: string | null;
  onSelect: (documentId: string) => void;
  onCreate: () => void;
  onDelete: (documentId: string) => void;
};

/**
 * The document library rail: a new-document button plus the user's documents,
 * newest-updated first. Selecting a row opens it in the workspace. Search /
 * facets / sort / pagination are deferred (see the page's `secondary:` note).
 */
const DocumentList: React.FC<DocumentListProps> = ({ documents, activeId, onSelect, onCreate, onDelete }) => {
  const { t } = useTranslation();

  return (
    <div className={styles.list} data-testid='documents-list'>
      <div className={styles.listHeader}>
        <span className={styles.listTitle}>{t('documents.list.title')}</span>
        <Button type='primary' size='mini' icon={<Plus size={14} />} onClick={onCreate} data-testid='documents-new'>
          {t('documents.newDocument')}
        </Button>
      </div>

      {documents.length === 0 ? (
        <div className={styles.listEmpty} data-testid='documents-list-empty'>
          <FileText size={28} className={styles.listEmptyIcon} />
          <span className={styles.listEmptyHint}>{t('documents.empty.hint')}</span>
        </div>
      ) : (
        <ul className={styles.listItems}>
          {documents.map((document) => (
            <li
              key={document.id}
              className={classNames(styles.listItem, { [styles.listItemActive]: document.id === activeId })}
              onClick={() => onSelect(document.id)}
              data-testid='documents-list-item'
            >
              <FileText size={16} className={styles.listItemIcon} />
              <span className={styles.listItemTitle}>{document.title.trim() || t('documents.tab.untitled')}</span>
              <Button
                type='text'
                size='mini'
                className={styles.listItemDelete}
                icon={<Trash2 size={14} />}
                aria-label={t('documents.delete')}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(document.id);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default DocumentList;
