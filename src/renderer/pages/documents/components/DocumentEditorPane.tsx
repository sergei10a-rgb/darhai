/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Input, Select } from '@arco-design/web-react';
// REUSE the existing Preview editors - the Documents workspace does NOT fork them.
// markdown -> TipTap WYSIWYG, html -> CodeMirror HTML, csv/code -> CodeMirror text.
import { HTMLEditor, TextEditor, TipTapMarkdownEditor } from '@renderer/pages/conversation/Preview/components/editors';
import type { DocumentEntity, DocumentLanguage } from '@/common/types/documents';
import styles from '../Documents.module.css';

const LANGUAGES: DocumentLanguage[] = ['markdown', 'html', 'csv', 'code'];

type SaveState = 'saved' | 'saving' | 'dirty';

type DocumentEditorPaneProps = {
  document: DocumentEntity;
  value: string;
  saveState: SaveState;
  onChange: (content: string) => void;
  onTitleChange: (title: string) => void;
  onLanguageChange: (language: DocumentLanguage) => void;
};

/**
 * The editing surface for one open document. The header carries the title +
 * language controls and a save-status hint; the body dispatches to the REUSED
 * Preview editor for the document's language. Keyed by document id + language at
 * the call site so switching document or language remounts a fresh editor.
 */
const DocumentEditorPane: React.FC<DocumentEditorPaneProps> = ({
  document,
  value,
  saveState,
  onChange,
  onTitleChange,
  onLanguageChange,
}) => {
  const { t } = useTranslation();

  const renderEditor = (): React.ReactNode => {
    if (document.language === 'markdown') {
      return <TipTapMarkdownEditor value={value} onChange={onChange} />;
    }
    if (document.language === 'html') {
      return <HTMLEditor value={value} onChange={onChange} filePath={`${document.id}.html`} />;
    }
    // csv + code both edit as plain text in the CodeMirror editor (CSV grid is deferred).
    return <TextEditor value={value} onChange={onChange} />;
  };

  const saveLabel =
    saveState === 'saving'
      ? t('documents.saving')
      : saveState === 'dirty'
        ? t('documents.dirty')
        : t('documents.saved');

  return (
    <div className={styles.editorPane}>
      <div className={styles.editorHeader}>
        <Input
          className={styles.titleInput}
          value={document.title}
          placeholder={t('documents.titlePlaceholder')}
          onChange={onTitleChange}
          aria-label={t('documents.titlePlaceholder')}
          data-testid='documents-title-input'
        />
        <Select
          className={styles.languageSelect}
          value={document.language}
          onChange={(next) => onLanguageChange(next as DocumentLanguage)}
          aria-label={t('documents.language.label')}
          data-testid='documents-language-select'
        >
          {LANGUAGES.map((language) => (
            <Select.Option key={language} value={language}>
              {t(`documents.language.${language}`)}
            </Select.Option>
          ))}
        </Select>
        <span className={styles.saveState} data-state={saveState} data-testid='documents-save-state'>
          {saveLabel}
        </span>
      </div>
      <div className={styles.editorBody}>{renderEditor()}</div>
    </div>
  );
};

export default DocumentEditorPane;
