/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { transformMessage } from '@/common/chat/chatLib';
import type { IMessageTips } from '@/common/chat/chatLib';
import { uuid } from '@/common/utils';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { TChatConversation, TokenUsageData } from '@/common/config/storage';
import type { ThoughtData } from '@/renderer/components/chat/ThoughtDisplay';
import { useAddOrUpdateMessage } from '@/renderer/pages/conversation/Messages/hooks';
import type { ExecutionPolicyFrame } from '@process/agent/wcore/capabilities/handlers/executionPolicy';
import type { BudgetGrantFrameData } from '@process/agent/wcore/capabilities/handlers/budgetGrants';
import type {
  HostDeliveryFrame,
  ProviderFailoverFrame,
} from '@process/agent/wcore/capabilities/handlers/hostDelegatedDelivery';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
};

/** What a capability notice looks like once it is copy rather than a frame. */
export type NoticeCopy = { content: string; severity: IMessageTips['content']['type'] };

/**
 * Turn a `provider_failover_receipt` frame into user-facing copy.
 *
 * A switched failover is graded `warning`, not `success`, even though the frame
 * itself carries `severity: 'info'`. The turn did continue - but it continued on
 * a different provider, which means a different company saw the conversation.
 * The engine grades this event `criticality: safety` for exactly that reason,
 * and a green tick would tell the user "all fine" about a change they may need
 * to act on.
 */
export function describeFailover(frame: ProviderFailoverFrame, t: TFunction): NoticeCopy {
  // Unreadable receipt: every provider/model field is null, so there is nothing
  // to name. Say that a switch happened and could not be read - inventing a
  // provider name here would be worse than admitting the gap.
  if (frame.verdict === 'malformed') {
    return { content: t('conversation.failover.malformed'), severity: 'warning' };
  }

  const reason = frame.reason
    ? t(`conversation.failover.reason.${frame.reason}`, { defaultValue: frame.reason })
    : t('conversation.failover.reason.unknown');

  // Only rejections are listed; an accepted candidate that simply was not
  // chosen tells the user nothing about why their turn moved.
  const rejected = frame.candidates
    .filter((candidate) => 'Err' in candidate.disposition)
    .map((candidate) => `${candidate.provider}/${candidate.model}: ${(candidate.disposition as { Err: string }).Err}`);

  const detail =
    rejected.length > 0
      ? // `rejected`, not `count`: i18next reserves `count` for plural selection
        // and would silently fall back to a `_one`/`_other` key no locale has.
        `\n${t('conversation.failover.rejectedHeader', { rejected: rejected.length })}\n${rejected.join('\n')}`
      : '';

  if (frame.verdict === 'exhausted') {
    return {
      content:
        t('conversation.failover.exhausted', {
          failedProvider: frame.failedProvider,
          failedModel: frame.failedModel,
          reason,
        }) + detail,
      severity: 'error',
    };
  }

  return {
    content:
      t('conversation.failover.switched', {
        failedProvider: frame.failedProvider,
        failedModel: frame.failedModel,
        reason,
        selectedProvider: frame.selectedProvider,
        selectedModel: frame.selectedModel,
      }) + detail,
    severity: 'warning',
  };
}

/**
 * Turn a failed host-delegated delivery into user-facing copy.
 *
 * The capability only announces FAILURES, so there is no success arm here. The
 * `unconfigured` flag separates the two failures the user can act on
 * differently: "no plugin for this platform is running" is a Settings problem,
 * anything else is a send that was attempted and refused.
 */
export function describeDelivery(frame: HostDeliveryFrame, t: TFunction): NoticeCopy {
  return {
    content: frame.unconfigured
      ? t('conversation.delivery.unconfigured', { platform: frame.platform })
      : t('conversation.delivery.failed', { platform: frame.platform, error: frame.error }),
    severity: 'warning',
  };
}

/** The granted amount as one phrase. Zero halves are omitted, not shown as "0". */
function describeAmount(tokens: number, costUsd: number, t: TFunction): string {
  const hasTokens = typeof tokens === 'number' && tokens > 0;
  const hasCost = typeof costUsd === 'number' && costUsd > 0;
  // The schema makes BOTH fields required, so a token-only grant answers with
  // `additional_cost_usd: 0`. Printing "US$ 0" beside it would read as a second
  // amount that was granted.
  if (hasTokens && hasCost) {
    return t('mcp.budgetResult.both', {
      tokens: t('mcp.budgetResult.tokens', { tokens: String(tokens) }),
      cost: t('mcp.budgetResult.cost', { cost: String(costUsd) }),
    });
  }
  if (hasTokens) return t('mcp.budgetResult.tokens', { tokens: String(tokens) });
  if (hasCost) return t('mcp.budgetResult.cost', { cost: String(costUsd) });
  return t('mcp.budgetResult.nothing');
}

/**
 * Turn the engine's answer to a budget grant into user-facing copy.
 *
 * Why every refusal reason gets its own sentence: "an administrator's policy
 * blocks this" and "a turn is still running, try again shortly" are opposite
 * instructions to the user, and the decoder went to the trouble of preserving
 * all nine precisely so the difference survives to here. Collapsing them into
 * "the grant was refused" would throw that away one line before it is read.
 *
 * The granted amount is the one the ENGINE reports, never the one the host
 * asked for - the schema lets it grant less, and a host that echoes the request
 * misreports spend in the one place a user checks it.
 */
export function describeBudgetGrant(frame: BudgetGrantFrameData, t: TFunction): NoticeCopy {
  if (frame.outcome === 'refused') {
    const reason = frame.refusalReason
      ? t(`mcp.budgetResult.reason.${frame.refusalReason}` as never, { defaultValue: frame.refusalReason })
      : t('mcp.budgetResult.reason.unknown');
    const retry = frame.retryable === true ? ` ${t('mcp.budgetResult.retry')}` : '';
    return {
      content: t('mcp.budgetResult.refused', { reason }) + retry,
      // A refusal that may work shortly is not the same news as one that never
      // will, and the colour is the fastest thing the user reads.
      severity: frame.retryable === true ? 'warning' : 'error',
    };
  }

  const granted = describeAmount(frame.additionalTokens, frame.additionalCostUsd, t);
  const shortTokens = typeof frame.requestedTokens === 'number' && frame.additionalTokens < frame.requestedTokens;
  const shortCost = typeof frame.requestedCostUsd === 'number' && frame.additionalCostUsd < frame.requestedCostUsd;
  if (shortTokens || shortCost) {
    return {
      content: t('mcp.budgetResult.grantedLess', {
        amount: granted,
        requested: describeAmount(frame.requestedTokens ?? 0, frame.requestedCostUsd ?? 0, t),
      }),
      severity: 'warning',
    };
  }

  return { content: t('mcp.budgetResult.granted', { amount: granted }), severity: 'success' };
}

export const useWCoreMessage = (
  conversation_id: string,
  options?: {
    onError?: (message: IResponseMessage) => void;
    onConfigChanged?: (capabilities: Record<string, unknown>) => void;
    /**
     * The engine's effective execution policy changed, or a revision was
     * refused. Called for EVERY decision, including rejections - a refused
     * receipt is exactly when the host's picture of "will edits auto-apply /
     * are we sandboxed" has gone stale, and that is what the badge must say.
     */
    onExecutionPolicy?: (frame: ExecutionPolicyFrame) => void;
  }
) => {
  const onError = options?.onError;
  const onConfigChanged = options?.onConfigChanged;
  const onConfigChangedRef = useRef(onConfigChanged);
  const onExecutionPolicy = options?.onExecutionPolicy;
  const onExecutionPolicyRef = useRef(onExecutionPolicy);
  const { t } = useTranslation();
  // Held in a ref, like the callbacks above: the stream subscription must not be
  // torn down and rebuilt every time the language changes, and a rebuild between
  // two frames of one turn would drop whatever arrived in the gap.
  const tRef = useRef(t);
  const addOrUpdateMessage = useAddOrUpdateMessage();
  const [streamRunning, setStreamRunning] = useState(false);
  const [hasActiveTools, setHasActiveTools] = useState(false);
  const [waitingResponse, setWaitingResponse] = useState(false);
  const [hasHydratedRunningState, setHasHydratedRunningState] = useState(false);
  const [thought, setThought] = useState<ThoughtData>({
    description: '',
    subject: '',
  });
  const [tokenUsage, setTokenUsage] = useState<TokenUsageData | null>(null);
  // Current active message ID to filter out events from old requests (prevents aborted request events from interfering with new ones)
  const activeMsgIdRef = useRef<string | null>(null);

  // Use refs to avoid useEffect re-subscription when these states change
  const hasActiveToolsRef = useRef(hasActiveTools);
  const streamRunningRef = useRef(streamRunning);
  const waitingResponseRef = useRef(waitingResponse);

  // Track whether current turn has content output
  // Only reset waitingResponse when finish arrives after content (not after tool calls)
  const hasContentInTurnRef = useRef(false);

  useEffect(() => {
    onConfigChangedRef.current = onConfigChanged;
  }, [onConfigChanged]);
  useEffect(() => {
    onExecutionPolicyRef.current = onExecutionPolicy;
  }, [onExecutionPolicy]);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  useEffect(() => {
    hasActiveToolsRef.current = hasActiveTools;
  }, [hasActiveTools]);
  useEffect(() => {
    streamRunningRef.current = streamRunning;
  }, [streamRunning]);

  // Throttle thought updates to reduce render frequency
  const thoughtThrottleRef = useRef<{
    lastUpdate: number;
    pending: ThoughtData | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ lastUpdate: 0, pending: null, timer: null });

  const throttledSetThought = useMemo(() => {
    const THROTTLE_MS = 50; // 50ms throttle interval
    return (data: ThoughtData) => {
      const now = Date.now();
      const ref = thoughtThrottleRef.current;

      if (now - ref.lastUpdate >= THROTTLE_MS) {
        ref.lastUpdate = now;
        ref.pending = null;
        if (ref.timer) {
          clearTimeout(ref.timer);
          ref.timer = null;
        }
        setThought(data);
      } else {
        ref.pending = data;
        if (!ref.timer) {
          ref.timer = setTimeout(
            () => {
              ref.lastUpdate = Date.now();
              ref.timer = null;
              if (ref.pending) {
                setThought(ref.pending);
                ref.pending = null;
              }
            },
            THROTTLE_MS - (now - ref.lastUpdate)
          );
        }
      }
    };
  }, []);

  // Cleanup throttle timer
  useEffect(() => {
    return () => {
      if (thoughtThrottleRef.current.timer) {
        clearTimeout(thoughtThrottleRef.current.timer);
      }
    };
  }, []);

  // Combined running state: waiting for response OR stream is running OR tools are active
  const running = waitingResponse || streamRunning || hasActiveTools;

  // Set current active message ID
  const setActiveMsgId = useCallback((msgId: string | null) => {
    activeMsgIdRef.current = msgId;
  }, []);

  useEffect(() => {
    return ipcBridge.conversation.responseStream.on((message) => {
      if (conversation_id !== message.conversation_id) {
        return;
      }

      // Filter out events not belonging to current active request (prevents aborted events from interfering)
      // Note: only filter out thought and start messages, other messages must be rendered
      if (activeMsgIdRef.current && message.msg_id && message.msg_id !== activeMsgIdRef.current) {
        if (message.type === 'thought') {
          return;
        }
      }

      switch (message.type) {
        case 'thought':
          // Auto-recover streamRunning if thought arrives after finish
          if (!streamRunningRef.current) {
            setStreamRunning(true);
            streamRunningRef.current = true;
          }
          throttledSetThought(message.data as ThoughtData);
          break;
        case 'start':
          setStreamRunning(true);
          streamRunningRef.current = true;
          // Don't reset waitingResponse here - let tool completion flow handle it
          break;
        case 'finish':
          {
            // wcore stream_end carries usage in data field
            const usageData = message.data as TokenUsage | undefined;
            if (usageData && typeof usageData === 'object' && 'input_tokens' in usageData) {
              const newTokenUsage: TokenUsageData = {
                totalTokens: (usageData.input_tokens || 0) + (usageData.output_tokens || 0),
              };
              setTokenUsage(newTokenUsage);
              void ipcBridge.conversation.update.invoke({
                id: conversation_id,
                updates: {
                  extra: { lastTokenUsage: newTokenUsage } as TChatConversation['extra'],
                },
                mergeExtra: true,
              });
            }
            setStreamRunning(false);
            setWaitingResponse(false);
            setThought({ subject: '', description: '' });
            // The refs too, not just the state. They are read synchronously by
            // the send path and by the auto-recover branches above, so leaving
            // them set after a turn ends keeps the composer locked and makes the
            // next message look like it arrived mid-stream. State setters are
            // async; these are the values the very next event sees.
            streamRunningRef.current = false;
            waitingResponseRef.current = false;
            hasActiveToolsRef.current = false;
          }
          break;
        case 'tool_group':
          {
            // Mark that current turn has content output
            hasContentInTurnRef.current = true;

            // Auto-recover streamRunning if tool_group arrives after finish
            if (!streamRunningRef.current) {
              setStreamRunning(true);
              streamRunningRef.current = true;
            }

            // Check if any tools are executing or awaiting confirmation
            const tools = message.data as Array<{ status: string; name?: string }>;
            const activeStatuses = new Set(['Executing', 'Confirming', 'Pending']);
            const hasActive = tools.some((tool) => activeStatuses.has(tool.status));
            const wasActive = hasActiveToolsRef.current;

            setHasActiveTools(hasActive);
            hasActiveToolsRef.current = hasActive; // Sync update ref immediately

            // When tools transition from active to inactive, set waitingResponse=true
            // because backend needs to continue sending requests to model
            if (wasActive && !hasActive && tools.length > 0) {
              setWaitingResponse(true);
              waitingResponseRef.current = true;
            }

            // If tools are awaiting confirmation, update thought hint
            const confirmingTool = tools.find((tool) => tool.status === 'Confirming');
            if (confirmingTool) {
              setThought({
                subject: 'Awaiting Confirmation',
                description: confirmingTool.name || 'Tool execution',
              });
            } else if (hasActive) {
              const executingTool = tools.find((tool) => tool.status === 'Executing');
              if (executingTool) {
                setThought({
                  subject: 'Executing',
                  description: executingTool.name || 'Tool',
                });
              }
            } else if (!streamRunningRef.current) {
              // All tools completed and stream stopped, clear thought
              setThought({ subject: '', description: '' });
            }

            // Continue passing message to message list update
            addOrUpdateMessage(transformMessage(message));
          }
          break;
        case 'config_changed':
          onConfigChangedRef.current?.(message.data as Record<string, unknown>);
          break;
        case 'sub_agent_event':
          // v0.9.4 sub-agent activity card - create or update keyed by parentCallId.
          // transformMessage handles the status+body merge; composeMessage/hooks.ts
          // merges updates into the same card via msg_id = parentCallId.
          addOrUpdateMessage(transformMessage(message));
          break;
        case 'workflow_run':
          // workflow_lifecycle_v1 run card, keyed by runId. Handled here and not
          // in `default` because the default arm sets hasContentInTurnRef and
          // flips streamRunning back on - a workflow run is a session-level fact
          // that can arrive between turns, and treating it as turn content would
          // leave the composer locked with nothing generating.
          addOrUpdateMessage(transformMessage(message));
          break;
        case 'execution_policy':
          // Not a message: the effective posture belongs next to the mode
          // selector, not in the transcript. Falling through to `default` would
          // push it into transformMessage and render a junk bubble.
          onExecutionPolicyRef.current?.(message.data as ExecutionPolicyFrame);
          break;
        case 'provider_failover_receipt':
          {
            const notice = describeFailover(message.data as ProviderFailoverFrame, tRef.current);
            addOrUpdateMessage({
              id: uuid(),
              type: 'tips',
              // A SYNTHETIC msg_id, deliberately. The frame carries the active
              // turn's msg_id, and the message list replaces in place on an
              // msg_id hit - reusing it would overwrite the assistant's own
              // reply with this notice. Two failovers in one turn are also two
              // separate facts and must not collapse into one line.
              msg_id: `failover:${uuid()}`,
              conversation_id: message.conversation_id,
              position: 'center',
              content: { content: notice.content, type: notice.severity },
            });
          }
          break;
        case 'budget_grant_result':
          {
            // The engine's answer to a grant this host offered. Handled here
            // rather than in `default` for both reasons the neighbouring arms
            // name: the default arm pushes the frame through transformMessage
            // (a junk bubble) and flips streamRunning back on - and this frame
            // arrives AFTER the capped turn already died, so it would leave the
            // composer locked with nothing generating.
            const frame = message.data as BudgetGrantFrameData;
            const notice = describeBudgetGrant(frame, tRef.current);
            addOrUpdateMessage({
              id: uuid(),
              type: 'tips',
              // Keyed by request_id: one notice per grant, and never the turn's
              // own msg_id (see the failover arm above).
              msg_id: `budget:${frame.requestId}`,
              conversation_id: message.conversation_id,
              position: 'center',
              content: { content: notice.content, type: notice.severity },
            });
          }
          break;
        case 'host_send_message_request':
          {
            // The capability announces FAILED deliveries only; a delivery that
            // worked is already visible as the agent's own tool result.
            const frame = message.data as HostDeliveryFrame;
            const notice = describeDelivery(frame, tRef.current);
            addOrUpdateMessage({
              id: uuid(),
              type: 'tips',
              // Keyed by call_id: one notice per delivery the engine asked for,
              // and never the turn's own msg_id (see the failover arm above).
              msg_id: `delivery:${frame.callId}`,
              conversation_id: message.conversation_id,
              position: 'center',
              content: { content: notice.content, type: notice.severity },
            });
          }
          break;
        default: {
          if (message.type === 'error') {
            setWaitingResponse(false);
            onError?.(message as IResponseMessage);
          } else {
            // Mark that current turn has content output (exclude error type)
            hasContentInTurnRef.current = true;
            // Reset waitingResponse when actual content arrives
            if (message.type === 'content') {
              setWaitingResponse(false);
              waitingResponseRef.current = false;
            }
            // Auto-recover streamRunning if content arrives after finish
            if (!streamRunningRef.current) {
              setStreamRunning(true);
              streamRunningRef.current = true;
            }
          }
          // Backend handles persistence, Frontend only updates UI
          addOrUpdateMessage(transformMessage(message));
          break;
        }
      }
    });
    // Note: hasActiveTools and streamRunning are accessed via refs to avoid re-subscription
  }, [conversation_id, addOrUpdateMessage, onError]);

  useEffect(() => {
    let cancelled = false;

    setThought({ subject: '', description: '' });
    setTokenUsage(null);
    hasContentInTurnRef.current = false;
    setHasHydratedRunningState(false);

    // Check actual conversation status from backend before resetting all running states
    // to avoid flicker when switching to a running conversation
    void ipcBridge.conversation.get.invoke({ id: conversation_id }).then((res) => {
      if (cancelled) {
        return;
      }

      if (!res) {
        setStreamRunning(false);
        streamRunningRef.current = false;
        setHasActiveTools(false);
        hasActiveToolsRef.current = false;
        setWaitingResponse(false);
        waitingResponseRef.current = false;
        setHasHydratedRunningState(true);
        return;
      }
      const isRunning = res.status === 'running';
      setStreamRunning(isRunning);
      streamRunningRef.current = isRunning;
      // Reset tool states - they will be restored by incoming messages if still active
      setHasActiveTools(false);
      hasActiveToolsRef.current = false;
      setWaitingResponse(isRunning);
      waitingResponseRef.current = isRunning;
      // Load persisted token usage stats
      if (res.type === 'wcore' && res.extra?.lastTokenUsage) {
        const { lastTokenUsage } = res.extra;
        if (lastTokenUsage.totalTokens > 0) {
          setTokenUsage(lastTokenUsage);
        }
      }
      setHasHydratedRunningState(true);
    });

    return () => {
      cancelled = true;
    };
  }, [conversation_id]);

  const resetState = useCallback(() => {
    setWaitingResponse(false);
    waitingResponseRef.current = false;
    setStreamRunning(false);
    streamRunningRef.current = false;
    setHasActiveTools(false);
    hasActiveToolsRef.current = false;
    setThought({ subject: '', description: '' });
    hasContentInTurnRef.current = false;
    // Clear active message ID to prevent filtering events from new messages after stop
    activeMsgIdRef.current = null;
  }, []);

  return {
    thought,
    setThought,
    running,
    hasHydratedRunningState,
    tokenUsage,
    setActiveMsgId,
    setWaitingResponse,
    resetState,
  };
};
