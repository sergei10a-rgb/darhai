/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Memory auto-extraction (Odysseus #2, native).
 *
 * After a conversation turn completes, optionally send the last few messages to
 * a cheap model asking it to extract durable personal facts, then append the
 * survivors to the native markdown memory store via ijfwArchiveService.quickAdd.
 *
 * Purely ADDITIVE and SAFE:
 *  - OPT-IN, default OFF. When off: ZERO LLM calls, ZERO writes.
 *  - Fire-and-forget: never throws across the listener, never blocks the turn.
 *  - Cost-bounded: a per-session cadence gate (every Nth turn) + a cooldown
 *    window + a cheap model + MAX 2 facts. Only the clean idle state runs;
 *    generating / error / stopped turns are skipped.
 *  - Injection-safe on write: the transcript is untrusted; quickAdd's
 *    sanitizeYamlScalar + frontmatter clamps make an injected line land as an
 *    inert fact value, never as frontmatter or a key.
 *
 * The class takes its collaborators via a deps object so it unit-tests with no
 * DB / LLM / disk; `createMemoryExtractor` wires the real ones.
 */

import log from 'electron-log';
import type { IConversationTurnCompletedEvent } from '@/common/adapter/ipcBridge';
import type { IConversationRepository } from '@process/services/database/IConversationRepository';
import type { TMessage } from '@/common/chat/chatLib';
import { oneShotComplete } from '@process/services/completion/oneShot';
import { getIjfwArchiveService } from './ijfwArchiveService';
import { getAutoExtractEnabled } from './memoryExtractSettings';
import {
  buildExtractPrompt,
  parseExtractedFacts,
  mapCategoryToMemoryType,
  MAX_FACTS,
  type TranscriptTurn,
  type ExtractedFact,
} from './memoryExtractPrompt';

// ===== Tunables =====

/** Only the clean "turn finished, idle" state triggers extraction. */
const TERMINAL_STATE: IConversationTurnCompletedEvent['state'] = 'ai_waiting_input';
/** Run extraction on every Nth eligible completed turn per session (cost gate). */
const EXTRACT_EVERY_N_TURNS = 4;
/** Per-session cooldown so a burst of completions can't re-run back-to-back. */
const EXTRACT_COOLDOWN_MS = 60_000;
/** How many recent text turns to analyze. */
const CONTEXT_WINDOW = 6;
/** Page size to pull from the DB before filtering to text turns. */
const MESSAGE_FETCH_SIZE = 30;
/** Token ceiling for the extraction call (headroom for reasoning models). */
const EXTRACT_MAX_TOKENS = 4096;

// ===== Deps =====

/** A durable-fact candidate scope + type resolved from the event. */
type WriteTarget = { scope: 'project' | 'global'; type: string };

export type MemoryExtractorDeps = {
  /** Toggle read. When false, onTurnCompleted does nothing. */
  isEnabled: () => boolean;
  /** Load the recent transcript (chronological, text-only) for a session. */
  loadTranscript: (sessionId: string) => Promise<TranscriptTurn[]>;
  /** Cheap one-shot completion (extraction prompt in, raw reply out). */
  complete: (prompt: string, maxTokens: number) => Promise<string>;
  /** True when a candidate fact is already known (dedupe against the store). */
  isDuplicate: (factText: string) => Promise<boolean>;
  /** Append a surviving fact to the native store. */
  quickAdd: (content: string, scope: 'project' | 'global', type: string) => Promise<void>;
  /** Clock (injectable for cooldown tests). */
  now?: () => number;
};

export type MemoryExtractorOptions = {
  cadence?: number;
  cooldownMs?: number;
};

type SessionState = {
  turnCount: number;
  lastRunAt: number;
};

// ===== Extractor =====

export class MemoryExtractor {
  private readonly deps: MemoryExtractorDeps;
  private readonly cadence: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionState>();

  constructor(deps: MemoryExtractorDeps, options: MemoryExtractorOptions = {}) {
    this.deps = deps;
    this.cadence = Math.max(1, options.cadence ?? EXTRACT_EVERY_N_TURNS);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? EXTRACT_COOLDOWN_MS);
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Listener entry. Fire-and-forget: decides synchronously whether to run, then
   * runs the extraction detached so it never blocks or throws across the turn.
   */
  onTurnCompleted(event: IConversationTurnCompletedEvent): void {
    if (!this.shouldRun(event)) return;
    // Detached; the async body is wrapped so nothing escapes the listener.
    void this.runExtraction(event.sessionId).catch((err) => {
      log.warn('[memory-extract] extraction failed', { err });
    });
  }

  /** Gate: toggle off, non-terminal state, cadence, and cooldown all skip. */
  private shouldRun(event: IConversationTurnCompletedEvent): boolean {
    if (!this.deps.isEnabled()) return false;
    const sessionId = event.sessionId;
    if (!sessionId) return false;
    // Only the clean idle completion; skip generating / confirming / stopped /
    // error / incognito-shaped turns (cost + relevance guard).
    if (event.state !== TERMINAL_STATE) return false;

    const state = this.sessions.get(sessionId) ?? { turnCount: 0, lastRunAt: 0 };
    state.turnCount += 1;
    this.sessions.set(sessionId, state);

    // Cadence gate: only every Nth eligible turn.
    if (state.turnCount % this.cadence !== 0) return false;

    // Cooldown / dedupe window: a second qualifying event too soon is skipped.
    const nowMs = this.now();
    if (state.lastRunAt !== 0 && nowMs - state.lastRunAt < this.cooldownMs) return false;
    state.lastRunAt = nowMs;
    return true;
  }

  private async runExtraction(sessionId: string): Promise<void> {
    const transcript = await this.deps.loadTranscript(sessionId);
    // Need at least a user message and an assistant reply to have signal.
    if (transcript.length < 2) return;

    const prompt = buildExtractPrompt(transcript);
    const raw = await this.deps.complete(prompt, EXTRACT_MAX_TOKENS);
    const facts = parseExtractedFacts(raw);
    if (facts.length === 0) return;

    const target = resolveWriteTarget();
    let written = 0;
    for (const fact of facts.slice(0, MAX_FACTS)) {
      // Sequential by design: each fact is deduped, then appended in order to a
      // single journal file - concurrent appends would race the shared file.
      // eslint-disable-next-line no-await-in-loop
      const stored = await this.storeFact(fact, target);
      if (stored) written += 1;
    }
    if (written > 0) {
      log.info('[memory-extract] stored auto-extracted facts', { sessionId, count: written });
    }
  }

  /** Dedupe one candidate, then append it if new. Returns true when written. */
  private async storeFact(fact: ExtractedFact, target: WriteTarget): Promise<boolean> {
    // Dedupe against what's already stored.
    if (await this.deps.isDuplicate(fact.text)) return false;
    // quickAdd APPENDS a new block; sanitizeYamlScalar + frontmatter clamps keep
    // the untrusted fact text inert on write.
    await this.deps.quickAdd(fact.text, target.scope, mapCategoryToMemoryType(fact.category));
    return true;
  }
}

/**
 * Resolve where a fact is written. Global by default: durable personal facts
 * (name, city, stable preferences) are cross-project. Kept as a function so a
 * future per-project routing can slot in without touching the extractor body.
 */
function resolveWriteTarget(): WriteTarget {
  return { scope: 'global', type: 'observation' };
}

// ===== Real wiring =====

/** Map a stored DB message to a transcript turn, or null to skip it. */
function toTranscriptTurn(message: TMessage): TranscriptTurn | null {
  if (message.type !== 'text') return null;
  const content = message.content;
  const text = typeof content?.content === 'string' ? content.content.trim() : '';
  if (!text) return null;
  // Persisted user messages are position 'right'; assistant content is 'left'.
  const role: TranscriptTurn['role'] = message.position === 'right' ? 'user' : 'assistant';
  return { role, content: text };
}

/**
 * Load the last {@link CONTEXT_WINDOW} text turns for a session, chronological.
 * Non-text messages (tool calls, thinking, status) are stripped as noise.
 */
async function loadTranscriptFromRepo(repo: IConversationRepository, sessionId: string): Promise<TranscriptTurn[]> {
  const { data } = await repo.getMessages(sessionId, 0, MESSAGE_FETCH_SIZE, 'DESC');
  const turns: TranscriptTurn[] = [];
  // data is newest-first; walk it and collect text turns until we have enough.
  for (const message of data) {
    const turn = toTranscriptTurn(message);
    if (turn) turns.push(turn);
    if (turns.length >= CONTEXT_WINDOW) break;
  }
  // Reverse back to chronological order for the transcript (immutably).
  return turns.toReversed();
}

/**
 * Dedupe a candidate against the store: run it through the archive's search
 * (hybrid substring + semantic) and treat a close containment match as a
 * duplicate. Fail-open (returns false) so a search hiccup never drops a fact.
 */
async function isDuplicateInArchive(factText: string): Promise<boolean> {
  try {
    const needle = factText.toLowerCase().trim();
    if (!needle) return false;
    const { entries } = await getIjfwArchiveService().listEntries({ search: factText, limit: 10 });
    return entries.some((entry) => {
      const summary = entry.summary.toLowerCase();
      const body = entry.bodyPreview.toLowerCase();
      return summary.includes(needle) || needle.includes(summary) || body.includes(needle);
    });
  } catch (err) {
    log.warn('[memory-extract] dedupe lookup failed; treating as new', { err });
    return false;
  }
}

/** Build the extractor wired to the real DB / LLM / archive collaborators. */
export function createMemoryExtractor(repo: IConversationRepository): MemoryExtractor {
  return new MemoryExtractor({
    isEnabled: getAutoExtractEnabled,
    loadTranscript: (sessionId) => loadTranscriptFromRepo(repo, sessionId),
    complete: (prompt, maxTokens) => oneShotComplete(prompt, { maxTokens }),
    isDuplicate: isDuplicateInArchive,
    quickAdd: (content, scope, type) => getIjfwArchiveService().quickAdd(content, scope, type),
  });
}
