/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import type {
  AiEditResult,
  AiSuggestion,
  CreateDocumentParams,
  DocumentEntity,
  UpdateDocumentParams,
} from '@/common/types/documents';

/**
 * Documents data layer for the workspace. Loads the current user's document
 * library (SWR-cached), revalidates on any `documents.onDocumentChanged` event,
 * and exposes the mutation + AI verbs the page needs. The main process owns
 * persistence, version history, and the model calls; this hook is a thin IPC
 * client. Library search / facets / sort / pagination are deferred (see the
 * page's `secondary:` note).
 */
export function useDocuments() {
  const { user } = useAuth();
  const userId = user?.id ?? '';

  const swrKey = userId ? `documents:${userId}` : null;

  const { data, isLoading, mutate } = useSWR<DocumentEntity[]>(
    swrKey,
    async () => ipcBridge.documents.list.invoke({ userId }),
    { revalidateOnFocus: false }
  );

  // Any mutation (from this window or an AI edit) refreshes the library.
  useEffect(() => {
    const unsubscribe = ipcBridge.documents.onDocumentChanged.on(() => {
      void mutate();
    });
    return () => unsubscribe();
  }, [mutate]);

  const documents = data ?? [];

  const createDocument = useCallback(
    async (params: Omit<CreateDocumentParams, 'userId'>): Promise<DocumentEntity | null> => {
      if (!userId) return null;
      const created = await ipcBridge.documents.create.invoke({ ...params, userId });
      await mutate();
      return created;
    },
    [userId, mutate]
  );

  const updateDocument = useCallback(
    async (documentId: string, updates: UpdateDocumentParams): Promise<DocumentEntity> => {
      const updated = await ipcBridge.documents.update.invoke({ documentId, updates });
      await mutate();
      return updated;
    },
    [mutate]
  );

  const deleteDocument = useCallback(
    async (documentId: string): Promise<void> => {
      await ipcBridge.documents.delete.invoke({ documentId });
      await mutate();
    },
    [mutate]
  );

  const aiEdit = useCallback(
    async (documentId: string, instruction: string): Promise<AiEditResult> => {
      const result = await ipcBridge.documents.aiEdit.invoke({ documentId, instruction });
      if (result.applied) await mutate();
      return result;
    },
    [mutate]
  );

  const aiSuggest = useCallback(async (documentId: string, instruction: string): Promise<AiSuggestion[]> => {
    return ipcBridge.documents.aiSuggest.invoke({ documentId, instruction });
  }, []);

  return {
    userId,
    documents,
    isLoading,
    refresh: mutate,
    createDocument,
    updateDocument,
    deleteDocument,
    aiEdit,
    aiSuggest,
  };
}
