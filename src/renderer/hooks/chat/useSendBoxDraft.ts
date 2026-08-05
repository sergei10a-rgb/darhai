import type { TChatConversation } from '@/common/config/storage';
import { useCallback } from 'react';
import useSWR from 'swr';
import type { FileOrFolderItem } from '@/renderer/utils/file/fileTypes';
export type { FileOrFolderItem } from '@/renderer/utils/file/fileTypes';

type Draft =
  | {
      _type: 'gemini';
      content: string;
      atPath: Array<string | FileOrFolderItem>;
      uploadFile: string[];
    }
  | {
      _type: 'claude';
      content: unknown;
    }
  | {
      _type: 'acp';
      content: string;
      atPath: Array<string | FileOrFolderItem>;
      uploadFile: string[];
    }
  | {
      _type: 'codex';
      content: string;
      atPath: Array<string | FileOrFolderItem>;
      uploadFile: string[];
    }
  | {
      _type: 'openclaw-gateway';
      content: string;
      atPath: Array<string | FileOrFolderItem>;
      uploadFile: string[];
    }
  | {
      _type: 'nanobot';
      content: string;
      atPath: Array<string | FileOrFolderItem>;
      uploadFile: string[];
    }
  | {
      _type: 'remote';
      content: string;
      atPath: Array<string | FileOrFolderItem>;
      uploadFile: string[];
    }
  | {
      _type: 'wcore';
      content: string;
      atPath: Array<string | FileOrFolderItem>;
      uploadFile: string[];
    };

/**
 * Currently supported conversation types and their corresponding draft objects.
 */
type SendBoxDraftStore = {
  [K in TChatConversation['type']]: Map<string, Extract<Draft, { _type: K }>>;
};

const store: SendBoxDraftStore = {
  gemini: new Map(),
  acp: new Map(),
  codex: new Map(),
  'openclaw-gateway': new Map(),
  nanobot: new Map(),
  remote: new Map(),
  wcore: new Map(),
};

/**
 * Typed-but-unsent text used to live only in the Map above, so a renderer
 * reload, an app restart, or a crash took it with them - "the system jumps and
 * all my words in the chat box are lost". Nothing about the composer suggests
 * the text is that fragile; people leave half-written messages there for hours.
 *
 * Each draft is mirrored to localStorage as it changes and read back on the
 * first miss. Storage can be full or unavailable, so every access degrades to
 * the in-memory behaviour rather than throwing into the composer.
 */
const DRAFT_STORAGE_PREFIX = 'send-box-draft';

const draftStorageKey = (type: string, conversation_id: string): string =>
  `${DRAFT_STORAGE_PREFIX}/${type}/${conversation_id}`;

function draftStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** An empty draft is not worth keeping, and leaving it would resurrect a sent message's leftovers. */
function isEmptyDraft(draft: Draft): boolean {
  if ('atPath' in draft) {
    return !draft.content && draft.atPath.length === 0 && draft.uploadFile.length === 0;
  }
  return !draft.content;
}

function readPersistedDraft<K extends TChatConversation['type']>(
  type: K,
  conversation_id: string
): Extract<Draft, { _type: K }> | undefined {
  try {
    const raw = draftStorage()?.getItem(draftStorageKey(type, conversation_id));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Draft;
    // A draft written by an older shape - or for another platform - is
    // discarded rather than fed into a composer that cannot render it.
    return parsed?._type === type ? (parsed as Extract<Draft, { _type: K }>) : undefined;
  } catch {
    return undefined;
  }
}

function writePersistedDraft(type: string, conversation_id: string, draft: Draft | undefined): void {
  const storage = draftStorage();
  if (!storage) return;
  try {
    if (!draft || isEmptyDraft(draft)) storage.removeItem(draftStorageKey(type, conversation_id));
    else storage.setItem(draftStorageKey(type, conversation_id), JSON.stringify(draft));
  } catch {
    // Quota exceeded or a private-mode store. The in-memory draft still works
    // for this session; failing the keystroke would be worse.
  }
}

const setInMemoryDraft = <K extends TChatConversation['type']>(
  type: K,
  conversation_id: string,
  draft: Extract<Draft, { _type: K }> | undefined
) => {
  // TODO import ts-pattern for exhaustive check
  switch (type) {
    case 'gemini':
      if (draft) {
        store.gemini.set(conversation_id, draft as Extract<Draft, { _type: 'gemini' }>);
      } else {
        store.gemini.delete(conversation_id);
      }
      break;
    case 'acp':
      if (draft) {
        store.acp.set(conversation_id, draft as Extract<Draft, { _type: 'acp' }>);
      } else {
        store.acp.delete(conversation_id);
      }
      break;
    case 'codex':
      if (draft) {
        store.codex.set(conversation_id, draft as Extract<Draft, { _type: 'codex' }>);
      } else {
        store.codex.delete(conversation_id);
      }
      break;
    case 'openclaw-gateway':
      if (draft) {
        store['openclaw-gateway'].set(conversation_id, draft as Extract<Draft, { _type: 'openclaw-gateway' }>);
      } else {
        store['openclaw-gateway'].delete(conversation_id);
      }
      break;
    case 'nanobot':
      if (draft) {
        store.nanobot.set(conversation_id, draft as Extract<Draft, { _type: 'nanobot' }>);
      } else {
        store.nanobot.delete(conversation_id);
      }
      break;
    case 'remote':
      if (draft) {
        store.remote.set(conversation_id, draft as Extract<Draft, { _type: 'remote' }>);
      } else {
        store.remote.delete(conversation_id);
      }
      break;
    case 'wcore':
      if (draft) {
        store.wcore.set(conversation_id, draft as Extract<Draft, { _type: 'wcore' }>);
      } else {
        store.wcore.delete(conversation_id);
      }
      break;
    default:
      break;
  }
};

const setDraft = <K extends TChatConversation['type']>(
  type: K,
  conversation_id: string,
  draft: Extract<Draft, { _type: K }> | undefined
) => {
  setInMemoryDraft(type, conversation_id, draft);
  writePersistedDraft(type, conversation_id, draft);
};

const getInMemoryDraft = <K extends TChatConversation['type']>(
  type: K,
  conversation_id: string
): Extract<Draft, { _type: K }> | undefined => {
  // TODO import ts-pattern for exhaustive check
  switch (type) {
    case 'gemini':
      return store.gemini.get(conversation_id) as Extract<Draft, { _type: K }>;
    case 'acp':
      return store.acp.get(conversation_id) as Extract<Draft, { _type: K }>;
    case 'codex':
      return store.codex.get(conversation_id) as Extract<Draft, { _type: K }>;
    case 'openclaw-gateway':
      return store['openclaw-gateway'].get(conversation_id) as Extract<Draft, { _type: K }>;
    case 'nanobot':
      return store.nanobot.get(conversation_id) as Extract<Draft, { _type: K }>;
    case 'remote':
      return store.remote.get(conversation_id) as Extract<Draft, { _type: K }>;
    case 'wcore':
      return store.wcore.get(conversation_id) as Extract<Draft, { _type: K }>;
    default:
      return undefined;
  }
};

const getDraft = <K extends TChatConversation['type']>(
  type: K,
  conversation_id: string
): Extract<Draft, { _type: K }> | undefined => {
  const cached = getInMemoryDraft(type, conversation_id);
  if (cached) return cached;
  const persisted = readPersistedDraft(type, conversation_id);
  // Rehydrate the Map so the rest of the session reads memory, not storage.
  if (persisted) setInMemoryDraft(type, conversation_id, persisted);
  return persisted;
};

/** Simulate a renderer reload in tests: drop memory, keep what was persisted. */
export const __clearInMemoryDraftsForTests = (): void => {
  for (const map of Object.values(store)) map.clear();
};

/**
 * React Hook for conversation draft operations of a given type.
 */
export const getSendBoxDraftHook = <K extends TChatConversation['type']>(
  type: K,
  initialValue: Extract<Draft, { _type: K }>
) => {
  function useDraft(conversation_id: string) {
    const swrRet = useSWR(
      [`/send-box/${type}/draft/${conversation_id}`, conversation_id],
      ([_, id]) => {
        return getDraft(type, id);
      },
      // Seeded synchronously: without this the first render shows an empty
      // composer and a partial update arriving in that window would rebuild
      // from the empty value and overwrite the saved text.
      { fallbackData: getDraft(type, conversation_id) }
    );

    const mutateDraft = useCallback(
      (draft: (k: Extract<Draft, { _type: K }>) => typeof k | undefined): void => {
        swrRet
          .mutate(
            (prev) => {
              const newDraft = draft(prev ?? getDraft(type, conversation_id) ?? initialValue);
              setDraft(type, conversation_id, newDraft);
              return newDraft;
            },
            { revalidate: false }
          )
          .catch((error) => {
            console.error('Failed to mutate draft:', error);
          });
      },
      [conversation_id]
    );

    return {
      get data() {
        return swrRet.data;
      },
      mutate: mutateDraft,
    };
  }

  return useDraft;
};
