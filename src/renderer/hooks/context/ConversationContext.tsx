/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext } from 'react';

/**
 * Conversation context interface
 */
export interface ConversationContextValue {
  /**
   * Conversation ID
   */
  conversationId: string;

  /**
   * Workspace directory path
   */
  workspace?: string;

  /**
   * Conversation type
   */
  type: 'gemini' | 'acp' | 'codex' | 'openclaw-gateway' | 'nanobot' | 'remote' | 'wcore';

  /**
   * Cron job ID (if this conversation was created by a scheduled task)
   */
  cronJobId?: string;

  /**
   * When true, platform chat components should hide the SendBox (e.g. sub-agents in team mode)
   */
  hideSendBox?: boolean;

  /**
   * Workflow session ID, present when this conversation is part of an active
   * workflow launch surface. Used by MessageText to route assistant message
   * bodies through WorkflowMessageBody so step markers are stripped and
   * forwarded to the session rail.
   */
  workflowSessionId?: string;
}

/**
 * Conversation context - provides session-level info such as workspace path
 */
const ConversationContext = createContext<ConversationContextValue | null>(null);

/**
 * Conversation context provider
 */
export const ConversationProvider: React.FC<{
  children: React.ReactNode;
  value: ConversationContextValue;
}> = ({ children, value }) => {
  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
};

/**
 * Hook to use conversation context
 */
export const useConversationContext = (): ConversationContextValue => {
  const context = useContext(ConversationContext);
  if (!context) {
    throw new Error('useConversationContext must be used within ConversationProvider');
  }
  return context;
};

/**
 * Hook to safely use conversation context (returns null if not in provider)
 */
export const useConversationContextSafe = (): ConversationContextValue | null => {
  return useContext(ConversationContext);
};
