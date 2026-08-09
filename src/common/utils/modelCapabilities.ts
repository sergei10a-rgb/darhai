/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IProvider, ModelType } from '@/common/config/storage';

/**
 * Embedding / retrieval model families.
 *
 * Most of these are NOT named with the literal word `embed` - `bge-m3`,
 * `gte-large`, `e5-mistral`, `voyage-3` - so the families have to be named. Each
 * stem is anchored to a token boundary (start of id, or one of `/ . : _ -` or
 * whitespace on each side) so a two- or three-letter stem cannot match inside an
 * unrelated chat id: `uae` must not trip the vendored `kuae-*` coding models,
 * and `e5` / `bge` / `gte` must not match mid-word.
 *
 * Exported so any other classifier stays consistent with this one rather than
 * growing a second, subtly different list.
 */
export const EMBEDDING_MODEL =
  /(?:^|[\s./:_-])(?:embeddings?|embed|bge|gte|e5|uae|voyage|jina-clip|retrieval|llm2vec)(?=$|[\s./:_-])/i;

/** Reranker / cross-encoder models. Never chat models. */
export const RERANK_MODEL = /(?:rerank|re-rank|re-ranker|re-ranking|retrieval|retriever)/i;

/**
 * Speech-to-text and text-to-speech models.
 *
 * Deliberately narrow: `whisper` and `tts` only. A bare `audio` is NOT matched,
 * because audio-capable CHAT models exist (`gpt-4o-audio-preview`) and hiding
 * those would be its own bug.
 */
export const SPEECH_MODEL = /(?:^|[\s./:_-])(?:whisper|tts)(?=$|[\s./:_-])/i;

/**
 * Image-generation models.
 *
 * Hiding these from the CHAT picker is only half the job - the other half is
 * making sure they are all offered in the place that does use them: Settings →
 * Image generation. Those two lists were written separately and drifted, so
 * `dall-e-3` was hidden from chat (right) and also missing from the image picker
 * (wrong) even though `imageGenCore` has a dedicated OpenAI Images-API path for
 * it. An OpenAI user could not select DALL·E at all.
 *
 * Both sides now read this one definition, so a model can never fall out of both.
 */
export const IMAGE_GENERATION_MODEL =
  /flux|diffusion|stabilityai|sd-|dall|cogview|janus|midjourney|mj-|imagen|image|banana/i;

/** Whether a model id names an image generator (Settings → Image generation). */
export const isImageGenerationModel = (modelName: string): boolean => IMAGE_GENERATION_MODEL.test(modelName);

/**
 * Capability matching regex patterns
 */
export const CAPABILITY_PATTERNS: Record<ModelType, RegExp> = {
  text: /gpt|claude|gemini|qwen|llama|mistral|deepseek/i,
  vision: /4o|claude-3|gemini-.*-pro|gemini-.*-flash|gemini-2\.0|qwen-vl|llava|vision/i,
  // Native VIDEO input. Deliberately narrow - only families with MEASURED video
  // support: Gemini 1.5+, Qwen VL/Omni lines, and the unified-multimodal
  // Qwen3.6/3.8 checkpoints (3.6-27B model card lists video input; 3.8-max
  // lists video on its provider page). Anything else is enabled per-provider
  // via the user-selected capability override, not by guessing here.
  video: /gemini|qwen[\d.]*[.-](?:vl|omni)|qwen3\.[68]/i,
  function_calling: /gpt-4|claude-3|gemini|qwen|deepseek/i,
  image_generation: IMAGE_GENERATION_MODEL,
  web_search: /search|perplexity/i,
  reasoning: /o1-|reasoning|think/i,
  embedding: EMBEDDING_MODEL,
  rerank: RERANK_MODEL,
  // Must be a SUPERSET of embedding + rerank + speech, so a non-chat model is
  // filtered OUT of the chat / workflow / team pickers rather than offered and
  // then failing the turn with a provider 400 ("does not support chat").
  //
  // The bare `embed` / `rerank` literals this replaces missed every
  // family-named embedding - `bge-m3`, `gte-large`, `e5-mistral`, `voyage-3`
  // contain neither word, so all of them were offered for chat.
  excludeFromPrimary: new RegExp(
    `dall-e|flux|stable-diffusion|midjourney|flash-image|image|${EMBEDDING_MODEL.source}|${RERANK_MODEL.source}|${SPEECH_MODEL.source}`,
    'i'
  ),
};

/**
 * Explicit exclusion lists (blacklist) for capabilities
 */
export const CAPABILITY_EXCLUSIONS: Record<ModelType, RegExp[]> = {
  text: [],
  vision: [/embed|rerank|dall-e|flux|stable-diffusion/i],
  // `gemini` alone would sweep in gemini-embedding-*; video GENERATORS (imagen,
  // veo) must never be tagged as video-INPUT chat models.
  video: [/embed|rerank|dall-e|flux|stable-diffusion|imagen|veo/i],
  function_calling: [
    /aqa(?:-[\w-]+)?/i,
    /imagen(?:-[\w-]+)?/i,
    /o1-mini/i,
    /o1-preview/i,
    /gemini-1(?:\\.[\w-]+)?/i,
    /dall-e/i,
    /embed/i,
    /rerank/i,
  ],
  image_generation: [],
  web_search: [],
  reasoning: [],
  embedding: [],
  rerank: [],
  excludeFromPrimary: [],
};

/**
 * Get the lowercase, normalized base model name for matching.
 */
export const getBaseModelName = (modelName: string): string => {
  return modelName
    .toLowerCase()
    .replace(/[^a-z0-9./-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

/**
 * Check whether a specific model within a provider has a given capability.
 * Returns true (supported), false (excluded), or undefined (unknown).
 */
export const hasSpecificModelCapability = (
  _platformModel: IProvider,
  modelName: string,
  type: ModelType
): boolean | undefined => {
  const baseModelName = getBaseModelName(modelName);
  const exclusions = CAPABILITY_EXCLUSIONS[type];
  const pattern = CAPABILITY_PATTERNS[type];

  const isExcluded = exclusions.some((excludePattern) => excludePattern.test(baseModelName));
  if (isExcluded) return false;

  return pattern.test(baseModelName) ? true : undefined;
};
