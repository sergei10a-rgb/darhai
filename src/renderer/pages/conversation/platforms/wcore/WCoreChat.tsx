/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConversationContextValue } from '@/renderer/hooks/context/ConversationContext';
import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import type { StepStatus, StepTransitionSource } from '@/common/types/workflowTypes';
import ActivationCard from '@renderer/components/activation/ActivationCard';
import AcpAuthFailureCard from '@renderer/components/activation/AcpAuthFailureCard';
import FlexFullContainer from '@renderer/components/layout/FlexFullContainer';
import { useProviderReadiness } from '@renderer/hooks/useProviderReadiness';
import MessageList from '@renderer/pages/conversation/Messages/MessageList';
import { MessageListProvider, useMessageLstCache } from '@renderer/pages/conversation/Messages/hooks';
import { getAcpAuthRemedy, type AcpAuthRemedy } from '@renderer/pages/conversation/platforms/acp/acpAuthFailure';
import { useAddEventListener } from '@renderer/utils/emitter';
import HOC from '@renderer/utils/ui/HOC';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import LocalImageView from '@renderer/components/media/LocalImageView';
import ConversationChatConfirm from '../../components/ConversationChatConfirm';
import WCoreSendBox from './WCoreSendBox';
import type { WCoreModelSelection } from './useWCoreModelSelection';

const WCoreChat: React.FC<{
  conversation_id: string;
  workspace: string;
  modelSelection: WCoreModelSelection;
  teamId?: string;
  agentSlotId?: string;
  sessionMode?: string;
  emptySlot?: React.ReactNode;
  workflowSessionId?: string;
  workflowTotalSteps?: number | null;
  workflowApplyStepMarker?:
    ((stepN: number, status: StepStatus, source?: StepTransitionSource) => Promise<void>) | null;
}> = ({
  conversation_id,
  workspace,
  modelSelection,
  teamId,
  agentSlotId,
  sessionMode,
  emptySlot,
  workflowSessionId,
  workflowTotalSteps,
  workflowApplyStepMarker,
}) => {
  useMessageLstCache(conversation_id);
  const navigate = useNavigate();
  const readiness = useProviderReadiness();

  // Auth-failure remedy card: shown above the send box when the engine reports a
  // provider key rejection (401). Built from the failing provider's label so the
  // remedy can offer to re-key that specific provider. The main process also
  // flips the provider off "connected" (WCoreManager).
  const [authRemedy, setAuthRemedy] = useState<AcpAuthRemedy | null>(null);
  useAddEventListener(
    'wcore.auth.failed.card',
    (p) => {
      if (p.conversation_id === conversation_id) {
        setAuthRemedy(getAcpAuthRemedy('wcore', p.providerLabel ? { providerKeyLabel: p.providerLabel } : undefined));
      }
    },
    [conversation_id]
  );
  // Reset the card when switching conversations.
  useEffect(() => {
    setAuthRemedy(null);
  }, [conversation_id]);
  // Wake-the-engine call to action: shown inline above the send box whenever no
  // working inference provider is configured (WS-4). A held first message
  // auto-fires once a provider connects.
  const engineAsleep = !readiness.ready && !readiness.loading;
  const goToModels = useCallback(() => navigate('/settings/models'), [navigate]);
  const updateLocalImage = LocalImageView.useUpdateLocalImage();
  useEffect(() => {
    updateLocalImage({ root: workspace });
  }, [workspace]);
  const conversationValue = useMemo<ConversationContextValue>(() => {
    return {
      conversationId: conversation_id,
      workspace,
      type: 'wcore',
      workflowSessionId,
      workflowTotalSteps,
      workflowApplyStepMarker,
    };
  }, [conversation_id, workspace, workflowSessionId, workflowTotalSteps, workflowApplyStepMarker]);

  return (
    <ConversationProvider value={conversationValue}>
      <div className='flex-1 flex flex-col px-20px min-h-0'>
        <FlexFullContainer>
          <MessageList className='flex-1' emptySlot={emptySlot} />
        </FlexFullContainer>
        {engineAsleep && (
          <div className='max-w-800px w-full mx-auto mb-8px'>
            <ActivationCard onUseOwnKey={goToModels} onUseClaudeCode={goToModels} />
          </div>
        )}
        {authRemedy && (
          <div className='max-w-800px w-full mx-auto mb-12px'>
            <AcpAuthFailureCard remedy={authRemedy} onAddKey={goToModels} onDismiss={() => setAuthRemedy(null)} />
          </div>
        )}
        <ConversationChatConfirm conversation_id={conversation_id}>
          <WCoreSendBox
            conversation_id={conversation_id}
            modelSelection={modelSelection}
            teamId={teamId}
            agentSlotId={agentSlotId}
            sessionMode={sessionMode}
          />
        </ConversationChatConfirm>
      </div>
    </ConversationProvider>
  );
};

export default HOC.Wrapper(MessageListProvider, LocalImageView.Provider)(WCoreChat);
