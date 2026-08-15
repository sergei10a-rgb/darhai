/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges that drive one chat turn from the renderer's send button to the
 * agent's reply. Everything here is on the hot path of a single conversation:
 * the three backend-specific turn drivers (Gemini, ACP, the shared default),
 * the store that parks a message while the engine is asleep, the confirmation
 * gate a tool call blocks on, the constitution that is re-read before every
 * turn, the compression mode applied to the prompt, the kickoff suggestions
 * shown when a conversation is still empty, and the side-question service the
 * turn driver calls for follow-ups. They are grouped because they share one
 * lifecycle - a turn - not because they share a prefix; a bridge that merely
 * stores conversation rows lives under `knowledge/` instead.
 *
 * Headroom: this directory is at the 10-child cap - nine turn modules plus this
 * barrel - so it has none. The next conversation-scoped bridge cannot land
 * beside these; it opens a subdirectory (the backend-specific turn drivers are
 * the obvious seam) and the guard fails the build if it is appended instead.
 */

export * from './acpConversationBridge';
export * from './compressionBridge';
export * from './constitutionBridge';
export * from './conversationBridge';
export * from './ConversationSideQuestionService';
export * from './geminiConversationBridge';
export * from './kickoffBridge';
export * from './pendingSendBridge';
export * from './toolConfirmationBridge';
