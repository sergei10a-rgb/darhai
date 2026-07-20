/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import classNames from 'classnames';
import type { DocumentEntity } from '@/common/types/documents';
import styles from '../Documents.module.css';

type DocumentTabsProps = {
  /** The open documents, in tab order. */
  tabs: DocumentEntity[];
  activeId: string | null;
  dirtyIds: ReadonlySet<string>;
  onSelect: (documentId: string) => void;
  onClose: (documentId: string) => void;
};

/**
 * The workspace's own tab strip - separate from the conversation Preview panel's
 * tabs. Shows every open document with a dirty dot and a close control.
 */
const DocumentTabs: React.FC<DocumentTabsProps> = ({ tabs, activeId, dirtyIds, onSelect, onClose }) => {
  const { t } = useTranslation();
  if (tabs.length === 0) return null;

  return (
    <div className={styles.tabs} role='tablist' data-testid='documents-tabs'>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role='tab'
          aria-selected={tab.id === activeId}
          className={classNames(styles.tab, { [styles.tabActive]: tab.id === activeId })}
          onClick={() => onSelect(tab.id)}
          data-testid='documents-tab'
        >
          {dirtyIds.has(tab.id) ? <span className={styles.tabDirty} aria-hidden='true' /> : null}
          <span className={styles.tabTitle}>{tab.title.trim() || t('documents.tab.untitled')}</span>
          <button
            type='button'
            className={styles.tabClose}
            aria-label={t('common.close')}
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
};

export default DocumentTabs;
