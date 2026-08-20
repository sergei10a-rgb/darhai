import { readConstitutionWithOverlay } from '@process/bridge/conversation/constitutionBridge';
import {
  estimateTokens,
  getLoadedTokenEncoder,
  loadTokenEncoder,
  type TokenCounterId,
} from '@/common/utils/tokenCount';

export interface ComposePromptOptions {
  /** Active assistant/specialist ID. Matches ~/.darhai/specialists/<id>.md. */
  assistantId?: string;
  /** Existing backend-specific system prompt. Appended below Constitution + overlay. */
  basePrompt?: string;
}

export interface ComposedPrompt {
  /** Final composed string, ready to inject into provider system slot. */
  text: string;
  /**
   * Approximate token count of `text`. Read it together with `tokenCounter` -
   * the number means nothing without knowing which counter produced it.
   */
  approxTokens: number;
  /**
   * Which counter produced `approxTokens`: the real o200k_base tokenizer, or
   * the `length / 4` fallback used before the tokenizer has finished loading.
   */
  tokenCounter: TokenCounterId;
  /**
   * Anthropic cache_control marker. Pass to messages.create as the
   * cache_control on the LAST block of the `system` array (a single
   * breakpoint wrapping the full prefix).
   */
  anthropicCacheControl: { type: 'ephemeral' };
  /** True if a per-specialist overlay file was found and included. */
  hadOverlay: boolean;
}

/**
 * Compose the Wayland Constitution + optional specialist overlay + backend
 * base prompt into a single system string. Stable across turns (no per-turn
 * variables, no timestamps), so the resulting prefix matches Anthropic /
 * OpenAI prompt caches turn-to-turn.
 *
 * Composition order:
 *   Constitution
 *   \n\n---\n\n
 *   SpecialistOverlay (if file exists)
 *   \n\n---\n\n
 *   basePrompt (if provided)
 *
 * Empty segments are filtered out, so the leading/trailing separators only
 * appear when both adjacent segments are non-empty.
 */
export function composePrompt(opts?: ComposePromptOptions): ComposedPrompt {
  const cacheControl = { type: 'ephemeral' } as const;
  const basePrompt = opts?.basePrompt ?? '';
  let constitution = '';
  let overlay: string | null = null;
  try {
    const result = readConstitutionWithOverlay(opts?.assistantId);
    constitution = result.constitution ?? '';
    overlay = result.overlay;
  } catch (err) {
    console.error('[composePrompt] readConstitutionWithOverlay failed', err);
  }
  const parts = [constitution, overlay ?? '', basePrompt].filter((p) => p && p.length > 0);
  const text = parts.join('\n\n---\n\n');
  // Warm the tokenizer on first use, never at boot: `composePrompt` is reached
  // from `conversationBridge`, which is on the main-process startup path, and
  // the o200k rank table MEASURED ~145 ms to load cold. Until that resolves,
  // `estimateTokens` returns the labelled `chars-div-4` fallback rather than
  // pretending the heuristic is a token count.
  void loadTokenEncoder();
  const estimate = estimateTokens(text, getLoadedTokenEncoder());
  return {
    text,
    approxTokens: estimate.tokens,
    tokenCounter: estimate.counter,
    anthropicCacheControl: cacheControl,
    hadOverlay: overlay !== null,
  };
}
