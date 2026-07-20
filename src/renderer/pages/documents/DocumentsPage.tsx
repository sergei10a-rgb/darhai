/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Message, Modal } from '@arco-design/web-react';
import { FileText } from 'lucide-react';
import PageShell from '@renderer/components/layout/PageShell';
import type { AiSuggestion, DocumentEntity, DocumentLanguage } from '@/common/types/documents';
import { useDocuments } from './useDocuments';
import { AiAssistBar, DocumentEditorPane, DocumentList, DocumentTabs, SuggestionsPanel } from './components';
import styles from './Documents.module.css';

// secondary: MVP ships the library + tabbed editor + AI improve/suggest. Deferred
// (not built here): library search / facets / sort / pagination, a version-history
// UI with restore + export-zip, CSV grid editing (CSV edits as Monaco text here),
// the PDF-form / annotation / email-reply subsystem, and ai-tidy.

/** Debounce before an idle edit is flushed to the documents DB (coalesced main-side). */
const AUTOSAVE_MS = 800;

/** The live editing buffer for the active document (source of truth while editing). */
type EditBuffer = {
  id: string;
  title: string;
  language: DocumentLanguage;
  content: string;
};

const DocumentsPage: React.FC = () => {
  const { t } = useTranslation();
  const { documents, createDocument, updateDocument, deleteDocument, aiEdit, aiSuggest } = useDocuments();

  const [openIds, setOpenIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [buffer, setBuffer] = useState<EditBuffer | null>(null);
  const [reloadNonce, setReloadNonce] = useState<Record<string, number>>({});
  const [suggestions, setSuggestions] = useState<AiSuggestion[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const bufferRef = useRef<EditBuffer | null>(buffer);
  bufferRef.current = buffer;

  const documentsById = useMemo(() => {
    const map = new Map<string, DocumentEntity>();
    for (const document of documents) map.set(document.id, document);
    return map;
  }, [documents]);

  const activeDoc = activeId ? (documentsById.get(activeId) ?? null) : null;
  const openTabs = useMemo(
    () => openIds.map((id) => documentsById.get(id)).filter((d): d is DocumentEntity => Boolean(d)),
    [openIds, documentsById]
  );

  // Sync the editing buffer from the active document on tab switch / first open.
  // Keyed on activeId only, so autosave-driven refreshes never clobber typing.
  useEffect(() => {
    if (!activeDoc) {
      setBuffer(null);
      return;
    }
    if (bufferRef.current?.id !== activeDoc.id) {
      setBuffer({
        id: activeDoc.id,
        title: activeDoc.title,
        language: activeDoc.language,
        content: activeDoc.content,
      });
      setSuggestions([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, activeDoc?.id]);

  const bumpReload = useCallback((id: string) => {
    setReloadNonce((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);

  const isDirty =
    !!buffer &&
    !!activeDoc &&
    (buffer.title !== activeDoc.title ||
      buffer.language !== activeDoc.language ||
      buffer.content !== activeDoc.content);

  // Autosave: flush an idle dirty buffer to the DB (version coalescing happens main-side).
  useEffect(() => {
    if (!buffer || !isDirty) return;
    const snapshot = buffer;
    const handle = setTimeout(() => {
      setSavingId(snapshot.id);
      void updateDocument(snapshot.id, {
        title: snapshot.title,
        language: snapshot.language,
        content: snapshot.content,
      })
        .catch(() => Message.error(t('documents.toast.saveFailed')))
        .finally(() => setSavingId((current) => (current === snapshot.id ? null : current)));
    }, AUTOSAVE_MS);
    return () => clearTimeout(handle);
  }, [buffer, isDirty, updateDocument, t]);

  const openDocument = useCallback((id: string) => {
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveId(id);
  }, []);

  const handleCreate = useCallback(async () => {
    try {
      const created = await createDocument({ title: '', language: 'markdown', content: '' });
      if (created) openDocument(created.id);
    } catch {
      Message.error(t('documents.toast.createFailed'));
    }
  }, [createDocument, openDocument, t]);

  const handleCloseTab = useCallback((id: string) => {
    setOpenIds((prev) => {
      const next = prev.filter((openId) => openId !== id);
      setActiveId((current) => (current === id ? (next[next.length - 1] ?? null) : current));
      return next;
    });
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      Modal.confirm({
        title: t('documents.deleteConfirm.title'),
        content: t('documents.deleteConfirm.content'),
        okText: t('documents.deleteConfirm.ok'),
        cancelText: t('documents.deleteConfirm.cancel'),
        onOk: async () => {
          try {
            await deleteDocument(id);
            handleCloseTab(id);
            Message.success(t('documents.toast.deleted'));
          } catch {
            Message.error(t('documents.toast.deleteFailed'));
          }
        },
      });
    },
    [deleteDocument, handleCloseTab, t]
  );

  const handleContentChange = useCallback((content: string) => {
    setBuffer((prev) => (prev ? { ...prev, content } : prev));
  }, []);

  const handleTitleChange = useCallback((title: string) => {
    setBuffer((prev) => (prev ? { ...prev, title } : prev));
  }, []);

  const handleLanguageChange = useCallback(
    (language: DocumentLanguage) => {
      setBuffer((prev) => (prev ? { ...prev, language } : prev));
      if (activeId) bumpReload(activeId);
    },
    [activeId, bumpReload]
  );

  const handleImprove = useCallback(
    async (instruction: string) => {
      if (!activeId) return;
      setAiBusy(true);
      try {
        const result = await aiEdit(activeId, instruction);
        if (result.applied && result.newVersion) {
          const newContent = result.newVersion.content;
          setBuffer((prev) => (prev && prev.id === activeId ? { ...prev, content: newContent } : prev));
          bumpReload(activeId);
          Message.success(t('documents.ai.applied'));
        } else {
          Message.info(t('documents.ai.noChange'));
        }
      } catch {
        Message.error(t('documents.ai.failed'));
      } finally {
        setAiBusy(false);
      }
    },
    [activeId, aiEdit, bumpReload, t]
  );

  const handleSuggest = useCallback(
    async (instruction: string) => {
      if (!activeId) return;
      setAiBusy(true);
      try {
        const proposed = await aiSuggest(activeId, instruction);
        setSuggestions(proposed);
        if (proposed.length === 0) Message.info(t('documents.ai.noChange'));
      } catch {
        Message.error(t('documents.ai.failed'));
      } finally {
        setAiBusy(false);
      }
    },
    [activeId, aiSuggest, t]
  );

  const applySuggestionContent = useCallback(
    (suggestion: AiSuggestion): boolean => {
      if (!activeId) return false;
      const current = bufferRef.current;
      if (!current || !current.content.includes(suggestion.find)) return false;
      const nextContent = current.content.replace(suggestion.find, suggestion.suggest);
      setBuffer((prev) => (prev && prev.id === activeId ? { ...prev, content: nextContent } : prev));
      return true;
    },
    [activeId]
  );

  const handleAcceptSuggestion = useCallback(
    (index: number) => {
      const suggestion = suggestions[index];
      if (suggestion) applySuggestionContent(suggestion);
      setSuggestions((prev) => prev.filter((_, i) => i !== index));
      if (activeId) bumpReload(activeId);
    },
    [suggestions, applySuggestionContent, activeId, bumpReload]
  );

  const handleRejectSuggestion = useCallback((index: number) => {
    setSuggestions((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleAcceptAll = useCallback(() => {
    let appliedAny = false;
    for (const suggestion of suggestions) {
      if (applySuggestionContent(suggestion)) appliedAny = true;
    }
    setSuggestions([]);
    if (appliedAny && activeId) bumpReload(activeId);
  }, [suggestions, applySuggestionContent, activeId, bumpReload]);

  const handleRejectAll = useCallback(() => setSuggestions([]), []);

  const dirtyIds = useMemo(() => {
    const set = new Set<string>();
    if (isDirty && buffer) set.add(buffer.id);
    return set;
  }, [isDirty, buffer]);

  const saveState = savingId === activeId ? 'saving' : isDirty ? 'dirty' : 'saved';
  const paneKey = activeDoc
    ? `${activeDoc.id}:${buffer?.language ?? activeDoc.language}:${reloadNonce[activeDoc.id] ?? 0}`
    : 'none';

  const rail = (
    <DocumentList
      documents={documents}
      activeId={activeId}
      onSelect={openDocument}
      onCreate={handleCreate}
      onDelete={handleDelete}
    />
  );

  return (
    <PageShell
      title={t('documents.pageTitle')}
      icon={<FileText size={20} />}
      subtitle={t('documents.description')}
      countLabel={t('documents.footer.count', { count: documents.length })}
      filterRail={rail}
      width='full'
      testId='documents-page'
    >
      {activeDoc && buffer ? (
        <div className={styles.workspace}>
          <DocumentTabs
            tabs={openTabs}
            activeId={activeId}
            dirtyIds={dirtyIds}
            onSelect={setActiveId}
            onClose={handleCloseTab}
          />
          <DocumentEditorPane
            key={paneKey}
            document={{ ...activeDoc, title: buffer.title, language: buffer.language }}
            value={buffer.content}
            saveState={saveState}
            onChange={handleContentChange}
            onTitleChange={handleTitleChange}
            onLanguageChange={handleLanguageChange}
          />
          <AiAssistBar busy={aiBusy} onImprove={handleImprove} onSuggest={handleSuggest} />
          <SuggestionsPanel
            suggestions={suggestions}
            onAccept={handleAcceptSuggestion}
            onReject={handleRejectSuggestion}
            onAcceptAll={handleAcceptAll}
            onRejectAll={handleRejectAll}
          />
        </div>
      ) : (
        <div className={styles.empty} data-testid='documents-empty'>
          <FileText size={40} className={styles.emptyIcon} />
          <span className={styles.emptyTitle}>{t('documents.empty.title')}</span>
          <span className={styles.emptyHint}>{t('documents.editor.empty')}</span>
        </div>
      )}
    </PageShell>
  );
};

export default DocumentsPage;
