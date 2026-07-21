/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import type { AcpBackend } from '@/common/types/acpTypes';
import type { StepStatus, StepTransitionSource } from '@/common/types/workflowTypes';
import AcpAuthFailureCard from '@/renderer/components/activation/AcpAuthFailureCard';
import { useAddEventListener } from '@/renderer/utils/emitter';
import { copyText } from '@/renderer/utils/ui/clipboard';
import { Message } from '@arco-design/web-react';
import { getAcpAuthRemedy, type AcpAuthRemedy } from './acpAuthFailure';
import FlexFullContainer from '@renderer/components/layout/FlexFullContainer';
import MessageList from '@renderer/pages/conversation/Messages/MessageList';
import { MessageListProvider, useMessageLstCache } from '@renderer/pages/conversation/Messages/hooks';
import HOC from '@renderer/utils/ui/HOC';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import ConversationChatConfirm from '../../components/ConversationChatConfirm';
import AcpSendBox from './AcpSendBox';

const AcpChat: React.FC<{
  conversation_id: string;
  workspace?: string;
  backend: AcpBackend;
  sessionMode?: string;
  cachedConfigOptions?: import('@/common/types/acpTypes').AcpSessionConfigOption[];
  agentName?: string;
  cronJobId?: string;
  hideSendBox?: boolean;
  teamId?: string;
  agentSlotId?: string;
  emptySlot?: React.ReactNode;
  workflowSessionId?: string;
  workflowTotalSteps?: number | null;
  workflowApplyStepMarker?:
    ((stepN: number, status: StepStatus, source?: StepTransitionSource) => Promise<void>) | null;
}> = ({
  conversation_id,
  workspace,
  backend,
  sessionMode,
  cachedConfigOptions,
  agentName,
  cronJobId,
  hideSendBox,
  teamId,
  agentSlotId,
  emptySlot,
  workflowSessionId,
  workflowTotalSteps,
  workflowApplyStepMarker,
}) => {
  useMessageLstCache(conversation_id);

  const navigate = useNavigate();
  const { t } = useTranslation();
  const [authRemedy, setAuthRemedy] = useState<AcpAuthRemedy | null>(null);

  useAddEventListener(
    'acp.auth.failed.card',
    (p) => {
      if (p.conversation_id === conversation_id) setAuthRemedy(getAcpAuthRemedy(p.backend));
    },
    [conversation_id]
  );

  // Reset the card when switching conversations.
  useEffect(() => {
    setAuthRemedy(null);
  }, [conversation_id]);

  const onAddKey = useCallback(() => {
    navigate('/settings/models');
  }, [navigate]);

  const onCliLogin = useCallback(async () => {
    if (!authRemedy?.cliLoginCmd) return;
    await copyText(authRemedy.cliLoginCmd);
    Message.success(t('conversation.acpAuthFailure.cliLogin.copied'));
  }, [authRemedy, t]);

  return (
    <ConversationProvider
      value={{
        conversationId: conversation_id,
        workspace,
        type: 'acp',
        cronJobId,
        hideSendBox,
        workflowSessionId,
        workflowTotalSteps,
        workflowApplyStepMarker,
      }}
    >
      <div className='flex-1 flex flex-col px-20px min-h-0'>
        <FlexFullContainer>
          <MessageList className='flex-1' emptySlot={emptySlot} />
        </FlexFullContainer>
        {!hideSendBox && authRemedy && (
          <div className='max-w-800px w-full mx-auto mb-12px'>
            <AcpAuthFailureCard
              remedy={authRemedy}
              onAddKey={onAddKey}
              onCliLogin={onCliLogin}
              onDismiss={() => setAuthRemedy(null)}
            />
          </div>
        )}
        {!hideSendBox && (
          <ConversationChatConfirm conversation_id={conversation_id}>
            <AcpSendBox
              conversation_id={conversation_id}
              backend={backend}
              sessionMode={sessionMode}
              cachedConfigOptions={cachedConfigOptions}
              agentName={agentName}
              workspacePath={workspace}
              teamId={teamId}
              agentSlotId={agentSlotId}
            ></AcpSendBox>
          </ConversationChatConfirm>
        )}
      </div>
    </ConversationProvider>
  );
};

export default HOC(MessageListProvider)(AcpChat);
