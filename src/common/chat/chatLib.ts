/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodexPermissionRequest } from '@/common/types/codex/types';
import type {
  ExecCommandBeginData,
  ExecCommandEndData,
  ExecCommandOutputDeltaData,
  McpToolCallBeginData,
  McpToolCallEndData,
  PatchApplyBeginData,
  PatchApplyEndData,
  TurnDiffData,
  WebSearchBeginData,
  WebSearchEndData,
} from '@/common/types/codex/types/eventData';
import type {
  AcpBackend,
  AgentBackend,
  AcpPermissionRequest,
  PlanUpdate,
  ToolCallUpdate,
} from '@/common/types/acpTypes';
import type { IResponseMessage } from '../adapter/ipcBridge';
import { uuid } from '../utils';

/**
 * Safe path join function, compatible with Windows and Mac.
 * @param basePath Base path
 * @param relativePath Relative path
 * @returns Joined absolute path
 */
export const joinPath = (basePath: string, relativePath: string): string => {
  // Normalize path separators to /
  const normalizePath = (path: string) => path.replace(/\\/g, '/');

  const base = normalizePath(basePath);
  const relative = normalizePath(relativePath);

  // Strip trailing slashes from base path
  const cleanBase = base.replace(/\/+$/, '');

  // Handle ./ and ../ in the relative path
  const parts = relative.split('/');
  const resultParts = [];

  for (const part of parts) {
    if (part === '.' || part === '') {
      continue; // Skip . and empty strings
    } else if (part === '..') {
      // Go up one directory level
      if (resultParts.length > 0) {
        resultParts.pop(); // Remove the last segment
      }
    } else {
      resultParts.push(part);
    }
  }

  // Join the path segments
  const result = cleanBase + '/' + resultParts.join('/');

  // Ensure the path is well-formed
  return result.replace(/\/+/g, '/'); // Collapse multiple consecutive slashes into one
};

/**
 * @description Message type declarations related to conversations, and associated helpers.
 */

type TMessageType =
  | 'text'
  | 'tips'
  | 'tool_call'
  | 'tool_group'
  | 'agent_status'
  | 'acp_permission'
  | 'acp_tool_call'
  | 'codex_permission'
  | 'codex_tool_call'
  | 'plan'
  | 'thinking'
  | 'available_commands'
  | 'skill_suggest'
  | 'cron_trigger'
  | 'cron_propose'
  | 'sub_agent'
  | 'workflow_run';

interface IMessage<T extends TMessageType, Content extends Record<string, any>> {
  /**
   * Unique ID
   */
  id: string;
  /**
   * Source message ID
   */
  msg_id?: string;

  // Conversation session ID
  conversation_id: string;
  /**
   * Message type
   */
  type: T;
  /**
   * Message content
   */
  content: Content;
  /**
   * Message creation timestamp
   */
  createdAt?: number;
  /**
   * Message position
   */
  position?: 'left' | 'right' | 'center' | 'pop';
  /**
   * Message status
   */
  status?: 'finish' | 'pending' | 'error' | 'work';
  /**
   * Hidden from UI display but persisted to DB and sent to agent.
   */
  hidden?: boolean;
}

export type CronMessageMeta = {
  source: 'cron';
  cronJobId: string;
  cronJobName: string;
  triggeredAt: number;
};

export type IMessageText = IMessage<
  'text',
  {
    content: string;
    cronMeta?: CronMessageMeta;
    teammateMessage?: boolean;
    senderName?: string;
    senderAgentType?: string;
    /** Sender teammate's conversation id - lets the renderer resolve preset avatars via their conversation extras. */
    senderConversationId?: string;
    /**
     * Set by WCoreManager when the response stopped with `finish_reason: 'length'`
     * (or matched the equivalent heuristic). Surfaces a "response truncated"
     * warning in the renderer; primarily fixes the Gemini Pro thinking-token
     * bug where reasoning models would return an empty bubble.
     */
    truncatedDueToBudget?: boolean;
  }
>;

export type IMessageTips = IMessage<'tips', { content: string; type: 'error' | 'success' | 'warning' }>;

export type IMessageToolCall = IMessage<
  'tool_call',
  {
    callId: string;
    name: string;
    args: Record<string, any>;
    error?: string;
    status?: 'success' | 'error';
  }
>;

type IMessageToolGroupConfirmationDetailsBase<Type, Extra extends Record<string, any>> = {
  type: Type;
  title: string;
} & Extra;

export type IMessageToolGroup = IMessage<
  'tool_group',
  Array<{
    callId: string;
    description: string;
    name: string;
    renderOutputAsMarkdown: boolean;
    resultDisplay?:
      | string
      | {
          fileDiff: string;
          fileName: string;
        }
      | {
          img_url: string;
          relative_path: string;
        };
    status: 'Executing' | 'Success' | 'Error' | 'Canceled' | 'Pending' | 'Confirming';
    confirmationDetails?:
      | IMessageToolGroupConfirmationDetailsBase<
          'edit',
          {
            fileName: string;
            fileDiff: string;
            isModifying?: boolean;
          }
        >
      | IMessageToolGroupConfirmationDetailsBase<
          'exec',
          {
            rootCommand: string;
            command: string;
          }
        >
      | IMessageToolGroupConfirmationDetailsBase<
          'info',
          {
            urls?: string[];
            prompt: string;
          }
        >
      | IMessageToolGroupConfirmationDetailsBase<
          'mcp',
          {
            toolName: string;
            toolDisplayName: string;
            serverName: string;
          }
        >;
  }>
>;

// Unified agent status message type for all ACP-based agents (Claude, Qwen, Codex, etc.)
export type IMessageAgentStatus = IMessage<
  'agent_status',
  {
    backend: AgentBackend; // Agent identifier: 'claude', 'qwen', 'codex', 'remote', etc.
    status: 'connecting' | 'connected' | 'authenticated' | 'session_active' | 'error';
    /** Display name for the agent (e.g. extension-contributed adapter name) */
    agentName?: string;
    // Optional legacy fields for backward compatibility
    sessionId?: string;
    isConnected?: boolean;
    hasActiveSession?: boolean;
  }
>;

export type IMessageAcpPermission = IMessage<'acp_permission', AcpPermissionRequest>;

export type IMessageAcpToolCall = IMessage<'acp_tool_call', ToolCallUpdate>;

export type IMessageCodexPermission = IMessage<'codex_permission', CodexPermissionRequest>;

// Base interface for all tool call updates
interface BaseCodexToolCallUpdate {
  toolCallId: string;
  status: 'pending' | 'executing' | 'success' | 'error' | 'canceled';
  title?: string; // Optional - can be derived from data or kind
  kind: 'execute' | 'patch' | 'mcp' | 'web_search';

  // UI display data
  description?: string;
  content?: Array<{
    type: 'text' | 'diff' | 'output';
    text?: string;
    output?: string;
    filePath?: string;
    oldText?: string;
    newText?: string;
  }>;

  // Timing
  startTime?: number;
  endTime?: number;
}

// Specific subtypes using the original event data structures
export type CodexToolCallUpdate =
  | (BaseCodexToolCallUpdate & {
      subtype: 'exec_command_begin';
      data: ExecCommandBeginData;
    })
  | (BaseCodexToolCallUpdate & {
      subtype: 'exec_command_output_delta';
      data: ExecCommandOutputDeltaData;
    })
  | (BaseCodexToolCallUpdate & {
      subtype: 'exec_command_end';
      data: ExecCommandEndData;
    })
  | (BaseCodexToolCallUpdate & {
      subtype: 'patch_apply_begin';
      data: PatchApplyBeginData;
    })
  | (BaseCodexToolCallUpdate & {
      subtype: 'patch_apply_end';
      data: PatchApplyEndData;
    })
  | (BaseCodexToolCallUpdate & {
      subtype: 'mcp_tool_call_begin';
      data: McpToolCallBeginData;
    })
  | (BaseCodexToolCallUpdate & {
      subtype: 'mcp_tool_call_end';
      data: McpToolCallEndData;
    })
  | (BaseCodexToolCallUpdate & {
      subtype: 'web_search_begin';
      data: WebSearchBeginData;
    })
  | (BaseCodexToolCallUpdate & {
      subtype: 'web_search_end';
      data: WebSearchEndData;
    })
  | (BaseCodexToolCallUpdate & {
      subtype: 'turn_diff';
      data: TurnDiffData;
    })
  | (BaseCodexToolCallUpdate & {
      subtype: 'generic';
      data?: any; // For generic updates that don't map to specific events
    });

export type IMessageCodexToolCall = IMessage<'codex_tool_call', CodexToolCallUpdate>;

export type IMessagePlan = IMessage<
  'plan',
  {
    sessionId: string;
    entries: PlanUpdate['update']['entries'];
  }
>;

export type IMessageThinking = IMessage<
  'thinking',
  {
    content: string;
    subject?: string;
    duration?: number;
    status: 'thinking' | 'done';
  }
>;

// Available commands from ACP agents (Claude, etc.)
export type AvailableCommand = {
  name: string;
  description: string;
  hint?: string;
};

export type IMessageAvailableCommands = IMessage<
  'available_commands',
  {
    commands: AvailableCommand[];
  }
>;

export type IMessageSkillSuggest = IMessage<
  'skill_suggest',
  {
    cronJobId: string;
    name: string;
    description: string;
    /** Full SKILL.md content (including frontmatter) */
    skillContent: string;
  }
>;

export type IMessageCronTrigger = IMessage<
  'cron_trigger',
  {
    cronJobId: string;
    cronJobName: string;
    triggeredAt: number;
  }
>;

/**
 * v0.6.2.6 - inline confirmation card rendered when the agent emits a
 * [CRON_PROPOSE] block in chat. User picks Yes/Edit/Cancel; the action
 * routes through ipcBridge.cron.confirmProposal which either creates the
 * job (Yes), opens CreateTaskDialog pre-filled (Edit), or marks the
 * proposal dismissed (Cancel). Status transitions are guarded
 * server-side to prevent double-fire from rapid clicks.
 */
export type IMessageCronPropose = IMessage<
  'cron_propose',
  {
    name: string;
    schedule: string;
    scheduleDescription: string;
    prompt: string;
    /** True if the cron expression failed croner validation; Yes button disabled in this state. */
    parseError: boolean;
    /**
     * Lifecycle of the proposal - drives which card variant renders.
     * v0.6.2.6.1 (race fix per Gemini G-R-01): `processing` is a transient
     * status the bridge sets BEFORE calling cronService.addJob, so a parallel
     * accept call sees non-pending and short-circuits. Reverted to `pending`
     * if addJob throws; transitions to `accepted` on success.
     */
    status: 'pending' | 'processing' | 'accepted' | 'cancelled';
    /** Set after accept - created cron job id so the card can link to its detail page. */
    cronJobId?: string;
    /** Conversation type as known when the proposal was created (for the post-accept addJob payload). */
    agentType?: string;
  }
>;

/**
 * v0.9.4 - inline activity card for a spawned sub-agent.
 * Keyed by parentCallId (e.g. "spawn:{idx}:{name}"). Multiple sub-agents
 * produce distinct cards, one per unique parentCallId. Status tracks the
 * lifecycle: running → done | failed. The body accumulates streamed text_delta
 * output from the inner WCoreEvent stream.
 */
export type IMessageSubAgent = IMessage<
  'sub_agent',
  {
    /** Opaque call-id used as the stable key to merge streaming updates. */
    parentCallId: string;
    /** Display name for the sub-agent (e.g. "compute-2plus2"). */
    agentName: string;
    /** Lifecycle status. */
    status: 'running' | 'done' | 'failed';
    /** Accumulated streamed output text from the sub-agent. */
    body: string;
  }
>;

/** Failure detail carried by a failed workflow node or a failed run. Mirrors the engine's `failure` object. */
export type WorkflowRunFailure = { code: string; message: string; retryable: boolean };

/**
 * v0.9.7-mn - one `.ron` workflow run, as the `workflow_lifecycle_v1` capability
 * projects it (`WorkflowRunSnapshot` in
 * `src/process/agent/wcore/capabilities/handlers/workflowLifecycle.ts`).
 *
 * The engine emits the WHOLE snapshot on every accepted mutation, keyed by
 * `runId` - so this card merges by replacement, never by append. That is the one
 * way it differs from `sub_agent`, which accumulates streamed text.
 */
export type IMessageWorkflowRun = IMessage<
  'workflow_run',
  {
    /** Correlation key for the run; also the message's `msg_id` so updates merge into one card. */
    runId: string;
    /** Stable id of the workflow definition, e.g. `desktop-audit`. */
    workflowId: string;
    /** Human-readable display name. May be empty - the card falls back to `workflowId`. */
    name: string;
    /**
     * The engine's DECLARED node count. NOT a completion denominator: the
     * engine is free to open a run with `node_count: 0` and then emit nodes,
     * and rendering "1 of 0" would report the engine's own inconsistency as a
     * Darhai bug. The card shows observed nodes and treats this as a hint.
     *
     * OPTIONAL, like the two fields below, and for one reason: absence and zero
     * are different facts and the card must not confuse them. The in-tree
     * reducer always populates all three, so this is defence against a future
     * or third-party projection - but half-applied defence is worse than none,
     * which is what shipped: `nodes` was coerced to `[]` (rendering a confident
     * "0 steps reported"), while a missing `missingTotal` made `> 0` false and
     * SUPPRESSED the lost-lines warning, and a missing `nodeCount` compared
     * unequal to `nodes.length` and printed "engine declared undefined".
     */
    nodeCount?: number;
    status: 'running' | 'succeeded' | 'failed';
    /**
     * How many run sequences never arrived. Always the true count even when the
     * reducer capped its enumerated list, so a "N lines lost" line must read
     * this and never `missingSequences.length`. Absent means the projection did
     * not say - which the card states, because silence here must never be read
     * as "nothing was lost".
     */
    missingTotal?: number;
    /** Absent means no node list arrived at all; an empty array means one arrived and was empty. */
    nodes?: Array<{
      nodeId: string;
      state: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';
      failure?: WorkflowRunFailure;
    }>;
    failure?: WorkflowRunFailure;
  }
>;

// eslint-disable-next-line max-len
export type TMessage =
  | IMessageText
  | IMessageTips
  | IMessageToolCall
  | IMessageToolGroup
  | IMessageAgentStatus
  | IMessageAcpPermission
  | IMessageAcpToolCall
  | IMessageCodexPermission
  | IMessageCodexToolCall
  | IMessagePlan
  | IMessageThinking
  | IMessageAvailableCommands
  | IMessageSkillSuggest
  | IMessageCronTrigger
  | IMessageCronPropose
  | IMessageSubAgent
  | IMessageWorkflowRun;

// Unified type for all user-interaction confirmation prompts
export interface IConfirmation<Option extends any = any> {
  title?: string;
  id: string;
  action?: string;
  description: string;
  callId: string;
  options: Array<{
    label: string;
    value: Option;
    params?: Record<string, string>; // Translation interpolation parameters
  }>;
  /**
   * Command type for exec confirmations (e.g., 'curl', 'npm', 'git')
   * Used for "always allow" permission memory
   */
  commandType?: string;
}

/**
 * @description Transform a backend response message into a frontend TMessage.
 */
export const transformMessage = (message: IResponseMessage): TMessage => {
  switch (message.type) {
    case 'error': {
      return {
        id: uuid(),
        type: 'tips',
        msg_id: message.msg_id,
        position: 'center',
        conversation_id: message.conversation_id,
        content: {
          content: message.data as string,
          type: 'error',
        },
      };
    }
    case 'content':
    case 'user_content': {
      const data = message.data;
      const isRichData = typeof data === 'object' && data !== null && 'content' in data;
      return {
        id: uuid(),
        type: 'text',
        msg_id: message.msg_id,
        position: message.type === 'content' ? 'left' : 'right',
        conversation_id: message.conversation_id,
        content: isRichData
          ? {
              content: (data as { content: string; cronMeta?: CronMessageMeta }).content,
              cronMeta: (data as { cronMeta?: CronMessageMeta }).cronMeta,
              ...((data as { truncatedDueToBudget?: boolean }).truncatedDueToBudget && {
                truncatedDueToBudget: true,
              }),
            }
          : { content: data as string },
        ...(message.hidden && { hidden: true }),
      };
    }
    case 'tool_call': {
      return {
        id: uuid(),
        type: 'tool_call',
        msg_id: message.msg_id,
        conversation_id: message.conversation_id,
        position: 'left',
        content: message.data as any,
      };
    }
    case 'tool_group': {
      return {
        type: 'tool_group',
        id: uuid(),
        msg_id: message.msg_id,
        conversation_id: message.conversation_id,
        content: message.data as any,
      };
    }
    case 'agent_status': {
      return {
        id: uuid(),
        type: 'agent_status',
        msg_id: message.msg_id,
        position: 'center',
        conversation_id: message.conversation_id,
        content: message.data as any,
      };
    }
    case 'acp_permission': {
      return {
        id: uuid(),
        type: 'acp_permission',
        msg_id: message.msg_id,
        position: 'left',
        conversation_id: message.conversation_id,
        content: message.data as any,
      };
    }
    case 'acp_tool_call': {
      return {
        id: uuid(),
        type: 'acp_tool_call',
        msg_id: message.msg_id,
        position: 'left',
        conversation_id: message.conversation_id,
        content: message.data as any,
      };
    }
    case 'codex_permission': {
      return {
        id: uuid(),
        type: 'codex_permission',
        msg_id: message.msg_id,
        position: 'left',
        conversation_id: message.conversation_id,
        content: message.data as any,
      };
    }
    case 'codex_tool_call': {
      return {
        id: uuid(),
        type: 'codex_tool_call',
        msg_id: message.msg_id,
        position: 'left',
        conversation_id: message.conversation_id,
        content: message.data as any,
      };
    }
    case 'plan': {
      return {
        id: uuid(),
        type: 'plan',
        msg_id: message.msg_id,
        position: 'left',
        conversation_id: message.conversation_id,
        content: message.data as any,
      };
    }
    case 'thinking': {
      const data = message.data as {
        content: string;
        subject?: string;
        duration?: number;
        status: 'thinking' | 'done';
      };
      return {
        id: uuid(),
        type: 'thinking',
        msg_id: message.msg_id,
        position: 'left',
        conversation_id: message.conversation_id,
        content: {
          content: data.content,
          subject: data.subject,
          duration: data.duration,
          status: data.status,
        },
      };
    }
    // Disabled: available_commands messages are too noisy and distracting in the chat UI
    case 'available_commands':
      break;
    case 'skill_suggest': {
      const suggestData = message.data as {
        cronJobId: string;
        name: string;
        description: string;
        skillContent: string;
      };
      return {
        id: uuid(),
        type: 'skill_suggest',
        msg_id: message.msg_id,
        conversation_id: message.conversation_id,
        position: 'center',
        content: suggestData,
      };
    }
    case 'cron_trigger': {
      const triggerData = message.data as {
        cronJobId: string;
        cronJobName: string;
        triggeredAt: number;
      };
      return {
        id: uuid(),
        type: 'cron_trigger',
        msg_id: message.msg_id,
        conversation_id: message.conversation_id,
        position: 'center',
        content: triggerData,
      };
    }
    case 'cron_propose': {
      // v0.6.2.6 - inline confirmation card for natural-language scheduling.
      // Data is broadcast from MessageMiddleware after the agent emits a
      // [CRON_PROPOSE] block; renderer maps to IMessageCronPropose for
      // CronProposeCard to render Yes/Edit/Cancel UI.
      const proposeData = message.data as IMessageCronPropose['content'];
      return {
        id: uuid(),
        type: 'cron_propose',
        msg_id: message.msg_id,
        conversation_id: message.conversation_id,
        position: 'left',
        content: proposeData,
      };
    }
    case 'sub_agent_event': {
      // v0.9.4 sub-agent activity card. The `data` field carries:
      //   { parentCallId: string; agentName: string; inner: unknown }
      // `inner` is the raw WCoreEvent from the child agent - we only read its
      // `type` field to advance the lifecycle and `text` for text_delta chunks.
      const saData = message.data as {
        parentCallId: string;
        agentName: string;
        inner: unknown;
      };
      const inner = saData.inner as { type?: string; text?: string } | null | undefined;
      const innerType = inner?.type ?? '';

      let status: IMessageSubAgent['content']['status'] = 'running';
      if (innerType === 'info') {
        status = 'done';
      } else if (innerType === 'error') {
        status = 'failed';
      }

      const body = innerType === 'text_delta' ? (inner?.text ?? '') : '';

      return {
        id: uuid(),
        type: 'sub_agent',
        // Use parentCallId as msg_id so composeMessage can merge streaming
        // updates for the same sub-agent into one card (same key lookup).
        msg_id: saData.parentCallId,
        conversation_id: message.conversation_id,
        position: 'left',
        content: {
          parentCallId: saData.parentCallId,
          agentName: saData.agentName,
          status,
          body,
        },
      };
    }
    case 'workflow_run': {
      // `workflow_lifecycle_v1` projection. The main-process reducer has already
      // validated every field against the engine schema (unknown node states,
      // negative sequences and conflicting terminals never reach here), so this
      // reads rather than re-validates.
      //
      // The three measurement fields are copied ONLY when the projection
      // actually carried them, and are optional on the message type for the
      // same reason. Coercing an absent `nodes` to `[]` turned "the projection
      // said nothing" into the card asserting "0 steps reported"; copying an
      // absent `missingTotal` straight through made `missingTotal > 0` false
      // and silently suppressed the "N stream lines were lost" banner, so a
      // projection that never mentioned loss read as one that reported none.
      // Absence travels as absence and the card says "not reported".
      const run = message.data as IMessageWorkflowRun['content'];
      return {
        id: uuid(),
        type: 'workflow_run',
        // runId as msg_id: every later snapshot for the same run merges into
        // this one card instead of stacking a new card per node transition.
        msg_id: run.runId,
        conversation_id: message.conversation_id,
        position: 'left',
        content: {
          runId: run.runId,
          workflowId: run.workflowId,
          name: run.name,
          ...(typeof run.nodeCount === 'number' && { nodeCount: run.nodeCount }),
          status: run.status,
          ...(typeof run.missingTotal === 'number' && { missingTotal: run.missingTotal }),
          ...(Array.isArray(run.nodes) && { nodes: run.nodes }),
          ...(run.failure && { failure: run.failure }),
        },
      };
    }
    case 'start':
    case 'finish':
    case 'thought':
    case 'info': // Stream retry notifications and similar transient agent updates
    case 'system': // Cron system responses, ignored
    case 'acp_model_info': // Model info updates, handled by AcpModelSelector
    case 'codex_model_info': // Codex model info updates, handled by AcpModelSelector
    case 'acp_context_usage': // Context usage updates, handled by AcpSendBox
    case 'request_trace': // Request trace events, logged to F12 console (not persisted)
      break;
    default: {
      console.warn(
        `[transformMessage] Unsupported message type '${message.type}'. All non-standard message types should be pre-processed by respective AgentManagers.`
      );
      break;
    }
  }
};

/**
 * @description Merge a message into the existing message list.
 */
export const composeMessage = (
  message: TMessage | undefined,
  list: TMessage[] | undefined,
  messageHandler: (type: 'update' | 'insert', message: TMessage) => void = () => {}
): TMessage[] => {
  if (!message) return list || [];
  if (!list?.length) {
    messageHandler('insert', message);
    return [message];
  }
  const last = list[list.length - 1];

  const updateMessage = (index: number, message: TMessage, change = true) => {
    message.id = list[index].id;
    list[index] = message;
    if (change) messageHandler('update', message);
    return list.slice();
  };
  const pushMessage = (message: TMessage) => {
    list.push(message);
    messageHandler('insert', message);
    return list.slice();
  };

  if (message.type === 'tool_group') {
    const remainingToolsMap = new Map(message.content.map((t) => [t.callId, t] as const));
    if (remainingToolsMap.size === 0) return list;

    const updatesToReport: TMessage[] = [];

    const updatedList = list.map((existingMessage) => {
      if (existingMessage.type !== 'tool_group') return existingMessage;
      if (!existingMessage.content.length) return existingMessage;

      let didMergeIntoThisMessage = false;
      const newContent = existingMessage.content.map((tool) => {
        const newToolData = remainingToolsMap.get(tool.callId);
        if (!newToolData) return tool;
        didMergeIntoThisMessage = true;
        remainingToolsMap.delete(tool.callId);
        // Create new object instead of mutating original
        return { ...tool, ...newToolData };
      });

      if (!didMergeIntoThisMessage) return existingMessage;
      const updatedMessage = { ...existingMessage, content: newContent } as TMessage;
      updatesToReport.push(updatedMessage);
      return updatedMessage;
    });

    const didUpdateExisting = updatesToReport.length > 0;
    for (const updatedMessage of updatesToReport) {
      messageHandler('update', updatedMessage);
    }

    const baseList = didUpdateExisting ? updatedList : list;

    // If there are new tool calls, append them as a new tool_group message (without mutating inputs)
    if (remainingToolsMap.size > 0) {
      const newTools = Array.from(remainingToolsMap.values());
      const insertMessage = { ...message, content: newTools } as TMessage;
      messageHandler('insert', insertMessage);
      return baseList.concat(insertMessage);
    }
    // No new tools appended; return a new list only if something was updated
    return didUpdateExisting ? baseList : list;
  }

  // Handle Gemini tool_call message merging
  if (message.type === 'tool_call') {
    for (let i = 0, len = list.length; i < len; i++) {
      const msg = list[i];
      if (msg.type === 'tool_call' && msg.content.callId === message.content.callId) {
        // Create new object instead of mutating original
        return updateMessage(i, { ...msg, content: { ...msg.content, ...message.content } });
      }
    }
    // If no existing tool call found, add new one
    return pushMessage(message);
  }

  // Handle codex_tool_call message merging
  if (message.type === 'codex_tool_call') {
    for (let i = 0, len = list.length; i < len; i++) {
      const msg = list[i];
      if (msg.type === 'codex_tool_call' && msg.content.toolCallId === message.content.toolCallId) {
        // Create new object instead of mutating original
        const merged = { ...msg.content, ...message.content };
        return updateMessage(i, { ...msg, content: merged });
      }
    }
    // If no existing tool call found, add new one
    return pushMessage(message);
  }

  // Handle acp_tool_call message merging (same logic as codex_tool_call)
  if (message.type === 'acp_tool_call') {
    for (let i = 0, len = list.length; i < len; i++) {
      const msg = list[i];
      if (msg.type === 'acp_tool_call' && msg.content.update?.toolCallId === message.content.update?.toolCallId) {
        // Create new object instead of mutating original
        const merged = { ...msg.content, ...message.content };
        return updateMessage(i, { ...msg, content: merged });
      }
    }
    // If no existing tool call found, add new one
    return pushMessage(message);
  }

  if (message.type === 'plan') {
    for (let i = 0, len = list.length; i < len; i++) {
      const msg = list[i];
      if (msg.type === 'plan' && msg.content.sessionId === message.content.sessionId) {
        // Create new object instead of mutating original
        const merged = { ...msg.content, ...message.content };
        return updateMessage(i, { ...msg, content: merged });
      }
    }
    return pushMessage(message);
    // If no existing plan found, add new one
  }

  // Handle thinking message merging - append streaming content by msg_id
  if (message.type === 'thinking') {
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i];
      if (msg.type === 'thinking' && msg.msg_id === message.msg_id) {
        // If incoming is 'done', update status and duration but keep accumulated content
        if (message.content.status === 'done') {
          const merged = {
            ...msg.content,
            status: message.content.status as 'done',
            duration: message.content.duration,
          };
          return updateMessage(i, { ...msg, content: merged });
        }
        // Otherwise append content
        const merged = {
          ...msg.content,
          content: msg.content.content + message.content.content,
          subject: message.content.subject || msg.content.subject,
        };
        return updateMessage(i, { ...msg, content: merged });
      }
    }
    return pushMessage(message);
  }

  // sub_agent message: merge by parentCallId (stored as msg_id).
  // Append body text and advance status toward terminal (done/failed wins over running).
  if (message.type === 'sub_agent' && message.msg_id) {
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i];
      if (msg.type === 'sub_agent' && msg.msg_id === message.msg_id) {
        const prevContent = msg.content;
        const nextContent = message.content;
        const mergedStatus =
          nextContent.status === 'done' || nextContent.status === 'failed' ? nextContent.status : prevContent.status;
        const mergedBody = prevContent.body + nextContent.body;
        const merged = { ...prevContent, status: mergedStatus, body: mergedBody } as typeof prevContent;
        return updateMessage(i, { ...msg, content: merged });
      }
    }
    return pushMessage(message);
  }

  // workflow_run: merge by runId (stored as msg_id) with REPLACEMENT, not append.
  // The reducer emits the whole run snapshot on every accepted mutation, so the
  // newest frame is already the complete truth; merging field-by-field would
  // resurrect nodes the engine has since dropped from the projection. Searched
  // from the end because a long-running workflow's card is usually recent but
  // need not be the last message - tool calls and text arrive between updates.
  if (message.type === 'workflow_run' && message.msg_id) {
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i];
      if (msg.type === 'workflow_run' && msg.msg_id === message.msg_id) {
        return updateMessage(i, { ...msg, content: message.content });
      }
    }
    return pushMessage(message);
  }

  if (last.msg_id !== message.msg_id || last.type !== message.type) {
    return pushMessage(message);
  }
  if (message.type === 'text' && last.type === 'text') {
    message.content.content = last.content.content + message.content.content;
  }
  return updateMessage(list.length - 1, Object.assign({}, last, message));
};

export const handleImageGenerationWithWorkspace = (message: TMessage, workspace: string): TMessage => {
  // Only process text-type messages
  if (message.type !== 'text') {
    return message;
  }

  // Deep-copy the message to avoid mutating the original object
  const processedMessage = {
    ...message,
    content: {
      ...message.content,
      content: message.content.content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, imagePath) => {
        // If the path is absolute, an http link, or a data URL, leave it unchanged
        if (
          imagePath.startsWith('http') ||
          imagePath.startsWith('data:') ||
          imagePath.startsWith('/') ||
          imagePath.startsWith('file:') ||
          imagePath.startsWith('\\') ||
          /^[A-Za-z]:/.test(imagePath)
        ) {
          return match;
        }
        // If the path is relative, join it with the workspace root
        const absolutePath = joinPath(workspace, imagePath);
        return `![${alt}](${encodeURI(absolutePath)})`;
      }),
    },
  };

  return processedMessage;
};
