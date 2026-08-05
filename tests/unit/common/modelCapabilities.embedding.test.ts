/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Non-chat models must not be offered in a chat picker.
 *
 * `excludeFromPrimary` used to look for the literal words `embed` and `rerank`.
 * Most embedding models are not named that way - `bge-m3`, `gte-large`,
 * `e5-mistral`, `voyage-3` contain neither - so they came back as ordinary chat
 * models and appeared in the chat, workflow and team pickers. Picking one killed
 * the turn with a provider 400: "does not support chat".
 *
 * The other half of this file matters just as much: the family stems are short
 * (`e5`, `bge`, `uae`), and a naive substring match would hide WORKING chat
 * models. `uae` inside `kuae-*` is the concrete case. So every exclusion is
 * anchored to a token boundary, and the negative cases below are what keep it
 * that way.
 */

import { describe, expect, it } from 'vitest';
import { CAPABILITY_PATTERNS, EMBEDDING_MODEL, isImageGenerationModel } from '@/common/utils/modelCapabilities';

const isExcluded = (modelId: string): boolean => CAPABILITY_PATTERNS.excludeFromPrimary.test(modelId);

describe('excludeFromPrimary - family-named embedding models', () => {
  const embeddings = [
    'bge-m3',
    'bge-m3:latest',
    'bge-large-en-v1.5',
    'gte-large',
    'gte-Qwen2-7B-instruct',
    'e5-mistral-7b-instruct',
    'multilingual-e5-large',
    'voyage-3',
    'voyage-code-3',
    'uae-large-v1',
    'jina-clip-v2',
    'text-embedding-3-small',
    'nomic-embed-text',
    'gemini-embedding-001',
    'llm2vec-mistral',
  ];

  it.each(embeddings)('keeps %s out of the chat picker', (modelId) => {
    expect(isExcluded(modelId)).toBe(true);
  });

  it.each(embeddings)('classifies %s as an embedding model', (modelId) => {
    expect(EMBEDDING_MODEL.test(modelId)).toBe(true);
  });
});

describe('excludeFromPrimary - rerankers, image and speech models', () => {
  it.each(['bge-reranker-v2-m3', 'jina-reranker-v2', 'cohere-rerank-3.5'])('excludes the reranker %s', (modelId) => {
    expect(isExcluded(modelId)).toBe(true);
  });

  it.each(['dall-e-3', 'stable-diffusion-3.5', 'gemini-2.5-flash-image', 'gemini-3-pro-image-preview'])(
    'excludes the image model %s',
    (modelId) => {
      expect(isExcluded(modelId)).toBe(true);
    }
  );

  it.each(['whisper-1', 'whisper-large-v3', 'tts-1', 'tts-1-hd'])('excludes the speech model %s', (modelId) => {
    expect(isExcluded(modelId)).toBe(true);
  });
});

describe('an image model hidden from chat is still offered where it IS used', () => {
  // Hiding a model from the chat picker is only correct if it remains reachable
  // in Settings → Image generation. Those two lists were maintained separately
  // and drifted: `dall-e-3` was hidden from chat AND missing from the image
  // picker, so an OpenAI user could not select DALL·E anywhere - even though
  // `imageGenCore` has a dedicated OpenAI Images-API path for that exact id.
  const imageModels = [
    'dall-e-3',
    'dall-e-2',
    'gpt-image-1',
    'gpt-image-2',
    'chatgpt-image-latest',
    'gemini-3-pro-image-preview',
    'gemini-2.5-flash-image',
    'nano-banana',
    'imagen-4.0-generate-001',
    'flux-2-pro',
    'stable-diffusion-3.5',
  ];

  it.each(imageModels)('%s is selectable as an image-generation model', (modelId) => {
    expect(isImageGenerationModel(modelId)).toBe(true);
  });

  it('never leaves an image model out of BOTH pickers', () => {
    // The rule, not a list: anything the app calls an image generator must be
    // offered in the image picker, whatever the chat picker does with it.
    const orphaned = imageModels.filter((modelId) => isExcluded(modelId) && !isImageGenerationModel(modelId));
    expect(orphaned).toEqual([]);
  });

  it('does not mistake a chat model for an image generator', () => {
    for (const modelId of ['gpt-5.1', 'claude-opus-4-8', 'gemini-3-pro-preview', 'qwen3-235b-a22b']) {
      expect(isImageGenerationModel(modelId)).toBe(false);
    }
  });
});

describe('excludeFromPrimary - must not hide working chat models', () => {
  // The failure mode on the other side of this fix. A short stem matched
  // mid-word would remove a usable model from the picker with no explanation,
  // which is harder to diagnose than the bug being fixed.
  const chatModels = [
    // `uae` inside `kuae` - the case that forced token anchoring.
    'kuae-cloud-coding-plan',
    'kuae-32b',
    // `bge` / `gte` / `e5` must not match mid-word.
    'gpt-5.1',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'gemini-3-pro-preview',
    'qwen3-235b-a22b',
    'deepseek-v3.2',
    'llama-4-maverick',
    'mistral-large-latest',
    // Audio-capable CHAT models: `audio` is deliberately not an exclusion stem.
    'gpt-4o-audio-preview',
    'gpt-realtime-audio',
  ];

  it.each(chatModels)('still offers %s', (modelId) => {
    expect(isExcluded(modelId)).toBe(false);
  });
});
