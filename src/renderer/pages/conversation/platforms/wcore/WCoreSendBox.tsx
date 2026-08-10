/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { Shield } from 'lucide-react';
import { ipcBridge } from '@/common';
import { uuid } from '@/common/utils';
import AgentModeSelector from '@/renderer/components/agent/AgentModeSelector';
import ContextUsageIndicator from '@/renderer/components/agent/ContextUsageIndicator';
import CommandQueuePanel from '@/renderer/components/chat/CommandQueuePanel';
import SendBox from '@/renderer/components/chat/sendbox';
import ThoughtDisplay from '@/renderer/components/chat/ThoughtDisplay';
import FileAttachButton from '@/renderer/components/media/FileAttachButton';
import FilePreview from '@/renderer/components/media/FilePreview';
import HorizontalFileList from '@/renderer/components/media/HorizontalFileList';
import { useAutoTitle } from '@/renderer/hooks/chat/useAutoTitle';
import { getSendBoxDraftHook, type FileOrFolderItem } from '@/renderer/hooks/chat/useSendBoxDraft';
import { createSetUploadFile, useSendBoxFiles } from '@/renderer/hooks/chat/useSendBoxFiles';
import { useSlashCommands } from '@/renderer/hooks/chat/useSlashCommands';
import { usePendingSendOnWake } from '@/renderer/hooks/chat/usePendingSendOnWake';
import { useOpenFileSelector } from '@/renderer/hooks/file/useOpenFileSelector';
import { useProviderReadiness } from '@/renderer/hooks/useProviderReadiness';
import { useLatestRef } from '@/renderer/hooks/ui/useLatestRef';
import { useAddOrUpdateMessage, useRemoveMessageByMsgId } from '@/renderer/pages/conversation/Messages/hooks';
import { assertBridgeSuccess } from '@/renderer/pages/conversation/platforms/assertBridgeSuccess';
import {
  shouldEnqueueConversationCommand,
  useConversationCommandQueue,
  type ConversationCommandQueueItem,
} from '@/renderer/pages/conversation/platforms/useConversationCommandQueue';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { allSupportedExts } from '@/renderer/services/FileService';
import { iconColors } from '@/renderer/styles/colors';
import { emitter, useAddEventListener } from '@/renderer/utils/emitter';
import { mergeFileSelectionItems } from '@/renderer/utils/file/fileSelection';
import { buildDisplayMessage, collectSelectedFiles } from '@/renderer/utils/file/messageFiles';
import { mergeWithCapabilities, type AgentModeOption } from '@/renderer/utils/model/agentModes';
import { getModelContextLimit } from '@/renderer/utils/model/modelContextLimits';
import { Message, Tag, Tooltip } from '@arco-design/web-react';
import type { ExecutionPolicyFrame } from '@process/agent/wcore/capabilities/handlers/executionPolicy';
import type { TFunction } from 'i18next';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWCoreMessage } from './useWCoreMessage';
import type { WCoreModelSelection } from './useWCoreModelSelection';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import { classifyAcpAuthFailure } from '@/renderer/pages/conversation/platforms/acp/acpAuthFailure';

const useWCoreSendBoxDraft = getSendBoxDraftHook('wcore', {
  _type: 'wcore',
  atPath: [],
  content: '',
  uploadFile: [],
});

const EMPTY_AT_PATH: Array<string | FileOrFolderItem> = [];
const EMPTY_UPLOAD_FILES: string[] = [];

const useSendBoxDraft = (conversation_id: string) => {
  const { data, mutate } = useWCoreSendBoxDraft(conversation_id);

  const atPath = data?.atPath ?? EMPTY_AT_PATH;
  const uploadFile = data?.uploadFile ?? EMPTY_UPLOAD_FILES;
  const content = data?.content ?? '';

  const setAtPath = useCallback(
    (nextAtPath: Array<string | FileOrFolderItem>) => {
      mutate((prev) => ({ ...prev, atPath: nextAtPath }));
    },
    [data, mutate]
  );

  const setUploadFile = createSetUploadFile(mutate, data);

  const setContent = useCallback(
    (nextContent: string) => {
      mutate((prev) => ({ ...prev, content: nextContent }));
    },
    [data, mutate]
  );

  return {
    atPath,
    uploadFile,
    setAtPath,
    setUploadFile,
    content,
    setContent,
  };
};

/**
 * The badge's tooltip, as lines.
 *
 * Pure and exported so the localization rule can be asserted against every
 * locale without driving Arco's popup, the same way `describeFailover` and
 * `describeDelivery` are testable on the sibling surface. Returning lines
 * rather than a joined string keeps "which line came from where" visible to a
 * test - which matters, because exactly one of these lines is untranslated
 * engine text and it has to stay labelled as such.
 */
export function policyTooltipLines(frame: ExecutionPolicyFrame, t: TFunction): string[] {
  const { policy, stale, verdict, detail, appliedRevision } = frame;

  // Two kinds of text, kept apart on purpose.
  //
  // `explanation` is Darhai's own answer, localized, keyed off the verdict
  // enum - the one field on this frame with a closed set of values, which is
  // what makes it translatable at all.
  //
  // `detail` is ENGINE OUTPUT and is always English: the main process builds it
  // out of schema vocabulary ("critical is not true, on a field the schema pins
  // to const: true", "revision 7 skips 2 revision(s) after 4"), and the main
  // process has no locale. Pushing it straight into the tooltip made the
  // badge's WORST state - no posture adopted for the one event graded
  // `critical: true` - the one place a Mongolian, Japanese or Turkish user got
  // nothing actionable, inside an otherwise fully localized surface, so it read
  // as a bug in the app rather than as engine text. It is still shown, because
  // it is the only string naming the exact field or revision at fault and so
  // the one worth quoting in a bug report - but behind a localized "engine
  // says" label, as a quotation rather than as Darhai's own copy.
  const explanation = t(`agentMode.policyVerdict.${verdict}`, { defaultValue: '' });
  const engineDetail = detail ? t('agentMode.policyEngineDetail', { detail }) : '';

  // A receipt the host refused before it ever adopted one leaves `policy` null.
  // The verdict line is the whole explanation here, so it must never be empty:
  // an unrecognised verdict falls back to the badge's own label rather than to
  // a blank tooltip.
  if (!policy) {
    const lines = [explanation, engineDetail].filter(Boolean);
    return lines.length > 0 ? lines : [t('agentMode.policyUnknown')];
  }

  return [
    policy.managed_floor_active ? t('agentMode.managedFloor') : '',
    policy.sandbox === 'bypass' ? t('agentMode.sandboxBypass') : '',
    // `policyStale` no longer interpolates the verdict: it used to print the
    // raw enum token ("gap", "version_mismatch") into thirteen locales. The
    // localized sentence for that same token is the next line.
    stale ? t('agentMode.policyStale') : '',
    explanation,
    // Revision is engine bookkeeping, but it is the number a user has to quote
    // when the app and the engine disagree, so it belongs in the tooltip.
    appliedRevision === null ? '' : t('agentMode.policyRevision', { revision: appliedRevision }),
    engineDetail,
  ].filter(Boolean);
}

/**
 * The engine's effective execution policy, next to the mode selector.
 *
 * WHY IT EXISTS. The mode selector shows what the user PICKED. It has never
 * shown what the engine APPLIED, and the two diverge for real reasons: a
 * managed floor clamps "Autopilot" back to prompt-on-every-action, and a
 * `sandbox: bypass` session is far more dangerous than the same label implies.
 * `execution_policy` is the only event in the whole engine contract marked
 * `critical: true`; before this badge Darhai dropped it on the floor.
 *
 * WHY IT SHOWS ON EVERY DECISION and not only on disagreement: the badge is
 * also how a REFUSED revision becomes visible. When the tracker reports `stale`
 * the host's picture of "will edits auto-apply / are we sandboxed" is provably
 * behind the engine's, and the honest thing to render is a warning, not the
 * last policy shown confidently.
 */
export const EffectivePolicyBadge: React.FC<{ frame: ExecutionPolicyFrame }> = ({ frame }) => {
  const { t } = useTranslation();
  const { policy, stale } = frame;
  const tooltip = <div className='whitespace-pre-line'>{policyTooltipLines(frame, t).join('\n')}</div>;

  // No posture to show, and showing the user's selected mode instead would be
  // inventing an answer for the one event graded `critical: true`.
  if (!policy) {
    return (
      <Tooltip content={tooltip}>
        <Tag size='small' color='red' data-testid='execution-policy-badge' data-policy-state='unknown'>
          {t('agentMode.policyUnknown')}
        </Tag>
      </Tooltip>
    );
  }

  const dangerous =
    policy.managed_floor_active || policy.sandbox === 'bypass' || policy.approvals === 'bypass' || stale;

  return (
    <Tooltip content={tooltip}>
      <Tag
        size='small'
        color={dangerous ? 'orange' : 'gray'}
        data-testid='execution-policy-badge'
        data-policy-state={dangerous ? 'attention' : 'ok'}
      >
        {t('agentMode.effectivePosture', {
          posture: t(`agentMode.${policy.posture}`, { defaultValue: policy.posture }),
          approvals: t(`agentMode.${policy.approvals}`, { defaultValue: policy.approvals }),
        })}
      </Tag>
    </Tooltip>
  );
};

const WCoreSendBox: React.FC<{
  conversation_id: string;
  modelSelection: WCoreModelSelection;
  teamId?: string;
  agentSlotId?: string;
  sessionMode?: string;
}> = ({ conversation_id, modelSelection, teamId, agentSlotId, sessionMode }) => {
  const [workspacePath, setWorkspacePath] = useState('');
  const [dynamicModes, setDynamicModes] = useState<AgentModeOption[]>([]);
  // null until the engine has told us anything. No badge is honest here: the
  // engine may be an older build that never emits `execution_policy`, and
  // showing a posture we never received would be a guess.
  const [executionPolicy, setExecutionPolicy] = useState<ExecutionPolicyFrame | null>(null);
  const { t } = useTranslation();
  const { checkAndUpdateTitle } = useAutoTitle();
  const { currentModel, getDisplayModelName } = modelSelection;
  const readiness = useProviderReadiness();
  // The engine is "asleep" when no working inference provider is configured.
  // While asleep we still let the user compose + send: the message is held in
  // the main process and auto-fires once a provider wakes the engine (WS-4).
  const engineAsleep = !readiness.ready && !readiness.loading;

  // When the engine surfaces a provider auth failure (e.g. 401 / invalid
  // x-api-key on a dead key), show the same remedy card the ACP backends use.
  // The main process separately flips that provider off "connected".
  const handleAuthError = useCallback(
    (message: IResponseMessage) => {
      const text = typeof message.data === 'string' ? message.data : String(message.data ?? '');
      if (classifyAcpAuthFailure('wcore', text)) {
        emitter.emit('wcore.auth.failed.card', { conversation_id, providerLabel: currentModel?.name });
      }
    },
    [conversation_id, currentModel?.name]
  );

  const { thought, running, hasHydratedRunningState, tokenUsage, setActiveMsgId, setWaitingResponse, resetState } =
    useWCoreMessage(conversation_id, {
      onConfigChanged: (capabilities) => {
        const modes = (capabilities as { modes?: string[] })?.modes;
        if (modes && modes.length > 0) {
          setDynamicModes(mergeWithCapabilities('wcore', modes));
        }
      },
      onExecutionPolicy: setExecutionPolicy,
      onError: handleAuthError,
    });

  const { atPath, uploadFile, setAtPath, setUploadFile, content, setContent } = useSendBoxDraft(conversation_id);

  useEffect(() => {
    void ipcBridge.conversation.get.invoke({ id: conversation_id }).then((res) => {
      if (!res?.extra?.workspace) return;
      setWorkspacePath(res.extra.workspace);
    });
  }, [conversation_id]);

  const slashCommands = useSlashCommands(conversation_id);

  const addOrUpdateMessage = useAddOrUpdateMessage();
  const removeMessageByMsgId = useRemoveMessageByMsgId();
  const { setSendBoxHandler } = usePreviewContext();
  const isBusy = running;

  const setContentRef = useLatestRef(setContent);
  const atPathRef = useLatestRef(atPath);

  // Register handler for adding text from preview panel to sendbox
  useEffect(() => {
    const handler = (text: string) => {
      const newContent = content ? `${content}\n${text}` : text;
      setContentRef.current(newContent);
    };
    setSendBoxHandler(handler);
  }, [setSendBoxHandler, content]);

  // Listen for sendbox.fill event to populate input from external sources
  useAddEventListener(
    'sendbox.fill',
    (text: string) => {
      setContentRef.current(text);
    },
    []
  );

  // Shared file handling logic
  const { handleFilesAdded, clearFiles } = useSendBoxFiles({
    atPath,
    uploadFile,
    setAtPath,
    setUploadFile,
  });

  const executeCommand = useCallback(
    async ({ input, files }: Pick<ConversationCommandQueueItem, 'input' | 'files'>) => {
      if (!currentModel?.useModel) {
        Message.warning(t('conversation.chat.noModelSelected'));
        throw new Error('No model selected');
      }

      const msg_id = uuid();
      setActiveMsgId(msg_id);
      setWaitingResponse(true);

      const displayMessage = buildDisplayMessage(input, files, workspacePath);
      if (!teamId) {
        addOrUpdateMessage(
          {
            id: msg_id,
            type: 'text',
            position: 'right',
            conversation_id,
            content: {
              content: displayMessage,
            },
            createdAt: Date.now(),
          },
          true
        );
      }

      try {
        void checkAndUpdateTitle(conversation_id, input);
        if (teamId) {
          if (agentSlotId) {
            const result = await ipcBridge.team.sendMessageToAgent.invoke({
              teamId,
              slotId: agentSlotId,
              content: displayMessage,
              files,
            });
            const maybeError = result as unknown as { __bridgeError?: boolean; message?: string };
            if (maybeError.__bridgeError) {
              throw new Error(maybeError.message || 'Failed to send message to agent');
            }
          } else {
            const result = await ipcBridge.team.sendMessage.invoke({ teamId, content: displayMessage, files });
            const maybeError = result as unknown as { __bridgeError?: boolean; message?: string };
            if (maybeError.__bridgeError) {
              throw new Error(maybeError.message || 'Failed to send message to team');
            }
          }
        } else {
          const result = await ipcBridge.conversation.sendMessage.invoke({
            input: displayMessage,
            msg_id,
            conversation_id,
            files,
          });
          assertBridgeSuccess(result, 'Failed to send message to Darhai Core');
        }
        emitter.emit('chat.history.refresh');
        if (files.length > 0) {
          emitter.emit('wcore.workspace.refresh');
        }
      } catch (error) {
        removeMessageByMsgId(msg_id);
        throw error;
      }
    },
    [
      addOrUpdateMessage,
      agentSlotId,
      checkAndUpdateTitle,
      conversation_id,
      currentModel?.useModel,
      setActiveMsgId,
      removeMessageByMsgId,
      setWaitingResponse,
      teamId,
      workspacePath,
    ]
  );

  // WS-4: hold a send while the engine is asleep; auto-fire it once a provider
  // wakes the engine (exactly-once, survives a remount into settings and back).
  const { holdIfAsleep } = usePendingSendOnWake({
    conversationId: conversation_id,
    asleep: engineAsleep,
    ready: readiness.ready,
    execute: executeCommand,
  });

  const {
    items: queuedCommands,
    isPaused: isQueuePaused,
    isInteractionLocked: isQueueInteractionLocked,
    hasPendingCommands,
    enqueue,
    remove,
    clear,
    reorder,
    pause,
    resume,
    lockInteraction,
    unlockInteraction,
    resetActiveExecution,
  } = useConversationCommandQueue({
    conversationId: conversation_id,
    enabled: true,
    isBusy,
    isHydrated: hasHydratedRunningState,
    onExecute: executeCommand,
  });

  // Handle initial message from Guid page
  useEffect(() => {
    if (!conversation_id) return;

    const storageKey = `wcore_initial_message_${conversation_id}`;
    const processedKey = `wcore_initial_processed_${conversation_id}`;

    const processInitialMessage = async () => {
      if (sessionStorage.getItem(processedKey)) return;
      const storedMessage = sessionStorage.getItem(storageKey);
      if (!storedMessage) return;

      sessionStorage.setItem(processedKey, '1');
      sessionStorage.removeItem(storageKey);

      try {
        const { input, files: initialFiles } = JSON.parse(storedMessage);
        await executeCommand({ input, files: initialFiles || [] });
      } catch (error) {
        console.error('[WCoreSendBox] Failed to send initial message:', error);
        sessionStorage.removeItem(processedKey);
      }
    };

    void processInitialMessage();
  }, [conversation_id, executeCommand]);

  const onSendHandler = async (message: string) => {
    if (!teamId && isBusy) {
      Message.warning(t('messages.conversationInProgress'));
      return;
    }

    const filesToSend = collectSelectedFiles(uploadFile, atPath);
    clearFiles();
    emitter.emit('wcore.selected.file.clear');

    // Engine asleep: park the message instead of dispatching it. The inline
    // ActivationCard (hosted by WCoreChat) is the call-to-action; the held
    // message auto-fires the moment a provider is connected.
    if (await holdIfAsleep(message, filesToSend)) {
      return;
    }

    if (
      shouldEnqueueConversationCommand({
        enabled: true,
        isBusy,
        hasPendingCommands,
      })
    ) {
      enqueue({ input: message, files: filesToSend });
      return;
    }

    await executeCommand({ input: message, files: filesToSend });
  };

  const handleEditQueuedCommand = useCallback(
    (item: ConversationCommandQueueItem) => {
      remove(item.id);
      setContent(item.input);
      setUploadFile(Array.from(new Set(item.files)));
      setAtPath([]);
      emitter.emit('wcore.selected.file.clear');
    },
    [remove, setAtPath, setContent, setUploadFile]
  );

  const appendSelectedFiles = useCallback(
    (files: string[]) => {
      setUploadFile((prev) => [...prev, ...files]);
    },
    [setUploadFile]
  );
  const { openFileSelector, onSlashBuiltinCommand } = useOpenFileSelector({
    onFilesSelected: appendSelectedFiles,
  });

  useAddEventListener('wcore.selected.file', setAtPath);
  useAddEventListener('wcore.selected.file.append', (selectedItems: Array<string | FileOrFolderItem>) => {
    const merged = mergeFileSelectionItems(atPathRef.current, selectedItems);
    if (merged !== atPathRef.current) {
      setAtPath(merged as Array<string | FileOrFolderItem>);
    }
  });

  // Stop conversation handler
  const handleStop = async (): Promise<void> => {
    try {
      await ipcBridge.conversation.stop.invoke({ conversation_id });
    } finally {
      resetState();
      resetActiveExecution('stop');
    }
  };

  return (
    <div className='max-w-800px w-full mx-auto flex flex-col mt-auto mb-16px'>
      <CommandQueuePanel
        items={queuedCommands}
        paused={isQueuePaused}
        interactionLocked={isQueueInteractionLocked}
        onPause={pause}
        onResume={resume}
        onInteractionLock={lockInteraction}
        onInteractionUnlock={unlockInteraction}
        onEdit={handleEditQueuedCommand}
        onReorder={reorder}
        onRemove={remove}
        onClear={clear}
      />
      <ThoughtDisplay thought={thought} running={running} onStop={handleStop} />

      <SendBox
        value={content}
        onChange={setContent}
        selectedWorkspaceItems={atPath}
        onSelectedWorkspaceItemsChange={(items) => {
          emitter.emit('wcore.selected.file', items);
          setAtPath(items);
        }}
        loading={isBusy}
        disabled={!currentModel?.useModel && !engineAsleep}
        placeholder={
          currentModel?.useModel
            ? t('conversation.chat.sendMessageTo', { model: getDisplayModelName(currentModel.useModel) })
            : t('conversation.chat.noModelSelected')
        }
        onStop={handleStop}
        className='z-10'
        onFilesAdded={handleFilesAdded}
        hasPendingAttachments={uploadFile.length > 0 || atPath.length > 0}
        supportedExts={allSupportedExts}
        defaultMultiLine={true}
        lockMultiLine={true}
        tools={
          <div className='flex items-center gap-4px'>
            <FileAttachButton openFileSelector={openFileSelector} onLocalFilesAdded={handleFilesAdded} />
            <AgentModeSelector
              backend='wcore'
              conversationId={conversation_id}
              compact
              initialMode={sessionMode}
              dynamicModes={dynamicModes}
              compactLeadingIcon={<Shield size={14} color={iconColors.secondary} />}
              modeLabelFormatter={(mode) => t(`agentMode.${mode.value}`, { defaultValue: mode.label })}
              compactLabelPrefix={t('agentMode.permission')}
              hideCompactLabelPrefixOnMobile
            />
            {executionPolicy && <EffectivePolicyBadge frame={executionPolicy} />}
          </div>
        }
        sendButtonPrefix={
          <ContextUsageIndicator
            tokenUsage={tokenUsage}
            contextLimit={getModelContextLimit(currentModel?.useModel)}
            size={24}
          />
        }
        prefix={
          <>
            {uploadFile.length > 0 && (
              <HorizontalFileList>
                {uploadFile.map((path) => (
                  <FilePreview
                    key={path}
                    path={path}
                    onRemove={() => setUploadFile(uploadFile.filter((v) => v !== path))}
                  />
                ))}
              </HorizontalFileList>
            )}
            {atPath.some((item) => (typeof item === 'string' ? false : !item.isFile)) && (
              <div className='flex flex-wrap items-center gap-8px mb-8px'>
                {atPath.map((item) => {
                  if (typeof item === 'string') return null;
                  if (!item.isFile) {
                    return (
                      <Tag
                        key={item.path}
                        color='blue'
                        closable
                        onClose={() => {
                          const newAtPath = atPath.filter((v) => (typeof v === 'string' ? true : v.path !== item.path));
                          emitter.emit('wcore.selected.file', newAtPath);
                          setAtPath(newAtPath);
                        }}
                      >
                        {item.name}
                      </Tag>
                    );
                  }
                  return null;
                })}
              </div>
            )}
          </>
        }
        onSend={onSendHandler}
        slashCommands={slashCommands}
        onSlashBuiltinCommand={onSlashBuiltinCommand}
        allowSendWhileLoading
      />
    </div>
  );
};

export default WCoreSendBox;
