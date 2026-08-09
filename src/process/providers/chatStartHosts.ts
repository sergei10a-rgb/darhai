/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProviderId } from './types';

/**
 * Canonical base URL per provider. A user-saved custom URL overrides this.
 *
 * Lives in its own module (not `modelRegistryIpc`) because BOTH the chat-start
 * payload builder and the legacy `model.config` mirror need it, and the mirror
 * module is imported BY `modelRegistryIpc` - importing the table back from
 * there would be a cycle.
 *
 * `providerHosts.test.ts` holds this against the connect-probe table in
 * `providerEndpoints.ts`. Those two must name the same HOST for a given
 * provider: the probe is what validates the key, so if inference points
 * somewhere else the key connects green and then 401s on the first message.
 */
export const CHAT_START_BASE_URL: Partial<Record<ProviderId, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  'google-gemini': 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  cohere: 'https://api.cohere.com/v1',
  perplexity: 'https://api.perplexity.ai',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  replicate: 'https://api.replicate.com/v1',
  huggingface: 'https://huggingface.co',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  anyscale: 'https://api.endpoints.anyscale.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  // Moonshot/Kimi global platform. `.ai` is the international endpoint; the
  // mainland-China `.cn` host rejects international keys (and vice versa).
  moonshot: 'https://api.moonshot.ai/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  baichuan: 'https://api.baichuan-ai.com/v1',
  lingyiwanwu: 'https://api.lingyiwanwu.com/v1',
  'zhipu-glm': 'https://open.bigmodel.cn/api/paas/v4',
  // International MiniMax platform (`.io`). The mainland-China `api.minimax.chat`
  // host rejects international keys and vice versa - the same split as Moonshot
  // above. Inference MUST use the host the key was validated against: the connect
  // probe in `providerEndpoints.ts` already uses `.io`, so pointing inference at
  // `.chat` made a key connect green and then 401 on the user's first message.
  minimax: 'https://api.minimax.io/v1',
  stability: 'https://api.stability.ai/v1',
  deepgram: 'https://api.deepgram.com/v1',
  assemblyai: 'https://api.assemblyai.com/v2',
  elevenlabs: 'https://api.elevenlabs.io/v1',
  // Hardcoded local Ollama OpenAI-compatible endpoint. Never user-overridable -
  // the keyless allowance is anchored to this fixed loopback host.
  'ollama-local': 'http://127.0.0.1:11434/v1',
};
