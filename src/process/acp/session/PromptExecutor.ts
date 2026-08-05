import { normalizeError } from '@process/acp/errors/errorNormalize';
import type { AcpMetrics } from '@process/acp/metrics/AcpMetrics';
import type { AuthNegotiator } from '@process/acp/session/AuthNegotiator';
import type { MessageTranslator } from '@process/acp/session/MessageTranslator';
import { PromptTimer } from '@process/acp/session/PromptTimer';
import type { SessionLifecycle } from '@process/acp/session/SessionLifecycle';
import type { AgentConfig, PromptContent, SessionCallbacks, SessionStatus } from '@process/acp/types';

/** Minimal interface that AcpSession exposes so PromptExecutor can drive state transitions. */
export type PromptHost = {
  readonly status: SessionStatus;
  readonly lifecycle: SessionLifecycle;
  readonly messageTranslator: MessageTranslator;
  readonly authNegotiator: AuthNegotiator;
  readonly callbacks: SessionCallbacks;
  readonly metrics: AcpMetrics;
  readonly agentConfig: AgentConfig;

  setStatus(status: SessionStatus): void;
  enterError(message: string): void;
};

export class PromptExecutor {
  /**
   * Messages waiting for the session to be ready, oldest first.
   *
   * This was a single slot, and the second message written into it dropped the
   * first on the floor. Sending two follow-ups while the agent was working -
   * or one while it was waking - lost one of them with no error and no trace in
   * the transcript. A queue is what the user already assumes is there.
   */
  private pendingPrompts: PromptContent[] = [];
  /** Guards against two flushes racing the same queue head. */
  private flushing = false;
  private readonly timer: PromptTimer;

  constructor(
    private readonly host: PromptHost,
    timeoutMs: number
  ) {
    this.timer = new PromptTimer(timeoutMs, () => this.handleTimeout());
  }

  // ─── Pending prompt buffer ────────────────────────────────────

  hasPending(): boolean {
    return this.pendingPrompts.length > 0;
  }

  /** Queue a message to send once the session is ready. */
  setPending(content: PromptContent): void {
    this.pendingPrompts.push(content);
  }

  clearPending(): void {
    this.pendingPrompts = [];
  }

  /**
   * Send queued messages, one turn at a time, while the session stays active.
   *
   * Two callers can fire this (a resumed session and a finished turn), so the
   * `flushing` flag keeps them from both taking the same head and sending it
   * twice. Each turn chains the next, so a queue drains in order rather than
   * all at once - a second prompt sent mid-turn is a protocol error, not a
   * faster reply.
   */
  flush(): void {
    if (this.flushing) return;
    const content = this.pendingPrompts[0];
    if (!content || this.host.status !== 'active') return;

    this.flushing = true;
    this.pendingPrompts.shift();
    void this.execute(content)
      // `execute` re-throws so a direct caller can report the failure. A
      // flushed message has no such caller, and the error already reached the
      // UI through `onSignal`.
      .catch(() => {})
      .finally(() => {
        this.flushing = false;
        this.flush();
      });
  }

  // ─── Execute ──────────────────────────────────────────────────

  async execute(content: PromptContent): Promise<void> {
    const { lifecycle } = this.host;
    if (!lifecycle.client || !lifecycle.sessionId) return;

    this.host.setStatus('prompting');

    try {
      await lifecycle.reassertConfig();
    } catch {
      /* best effort - continue to prompt even if config sync fails */
    }

    try {
      this.timer.start();
      const result = await lifecycle.client.prompt(lifecycle.sessionId, content);
      this.timer.stop();

      // Fallback: emit usage from PromptResponse for backends that don't send usage_update
      if (result.usage) {
        this.host.callbacks.onContextUsage({
          used: result.usage.totalTokens,
          total: 0,
          percentage: 0,
        });
      }
    } catch (err) {
      this.timer.stop();
      this.host.messageTranslator.onTurnEnd();
      this.handlePromptError(err, content);
      return;
    }

    this.host.messageTranslator.onTurnEnd();
    this.host.setStatus('active');
    this.host.callbacks.onSignal({ type: 'turn_finished' });
    // Anything typed during the turn goes now. Without this a queued follow-up
    // would wait for some unrelated event to flush it - which, for a session
    // that never suspends, may be never.
    this.flush();
  }

  private handlePromptError(err: unknown, content: PromptContent): void {
    const acpErr = normalizeError(err);

    if (acpErr.code === 'AUTH_REQUIRED') {
      // Back to the head, not the tail: this message was next, and signing in
      // should resume where the user left off rather than reorder their queue.
      this.pendingPrompts.unshift(content);
      this.host.lifecycle.setAuthPendingForPrompt();
      void this.host.lifecycle.teardown().then(() => {
        this.host.setStatus('error');
        this.host.callbacks.onSignal({
          type: 'auth_required',
          auth: this.host.authNegotiator.buildAuthRequiredData(undefined),
        });
      });
      return;
    }

    console.error(`[PromptExecutor] prompt failed (${acpErr.code}):`, acpErr.message);
    this.host.metrics.recordError(this.host.agentConfig.agentBackend, acpErr.code);

    if (acpErr.retryable) {
      this.host.setStatus('active');
      this.host.callbacks.onSignal({ type: 'error', message: acpErr.message, recoverable: true });
    } else {
      this.host.enterError(acpErr.message);
    }

    // Re-throw so callers (AcpSession.sendMessage → AcpAgentV2.sendMessage) can
    // return structured error types to AcpAgentManager.
    throw acpErr;
  }

  // ─── Cancel ───────────────────────────────────────────────────

  cancel(): void {
    const { lifecycle } = this.host;
    if (this.host.status !== 'prompting' || !lifecycle.client || !lifecycle.sessionId) return;
    lifecycle.client.cancel(lifecycle.sessionId).catch(() => {});
  }

  cancelAll(): void {
    this.pendingPrompts = [];
    if (this.host.status === 'prompting') this.cancel();
  }

  // ─── Timer delegation (for permission pause/resume) ───────────

  pauseTimer(): void {
    this.timer.pause();
  }

  resumeTimer(): void {
    this.timer.resume();
  }

  resetTimer(): void {
    this.timer.reset();
  }

  stopTimer(): void {
    this.timer.stop();
  }

  private handleTimeout(): void {
    if (this.host.status !== 'prompting') return;
    this.cancel();
    this.host.callbacks.onSignal({
      type: 'error',
      message: 'Prompt timed out',
      recoverable: true,
    });
  }
}
