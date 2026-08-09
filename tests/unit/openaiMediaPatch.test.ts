/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Media patch for the vendored OpenAI-compat converter.
 *
 * Proves that:
 *  (1) BASELINE - the vendored `convertToOpenAIFormat` drops inlineData
 *      silently (the measured bug: attached images/videos never reach a model
 *      behind an OpenAI-compatible endpoint),
 *  (2) with the patch, image/* becomes an `image_url` part and video/*
 *      becomes a `video_url` part (data URLs),
 *  (3) a media-only user message survives instead of being dropped as empty,
 *  (4) tool-sibling media (the lazy read_file path) is injected as a user
 *      message directly AFTER the matching tool message,
 *  (5) unsupported mimes keep today's dropped behaviour,
 *  (6) the patch is idempotent.
 *
 * Imports the REAL vendored class, so a dependency bump that changes the
 * converter shape this patch relies on fails HERE loudly instead of silently
 * re-breaking media input.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { OpenAIContentGenerator } from '@office-ai/aioncli-core/dist/src/core/openaiContentGenerator.js';
import {
  applyOpenAiMediaPatch,
  extractMedia,
  injectMedia,
  type OpenAiContentPart,
} from '@process/agent/gemini/openaiMediaPatch';

type AnyMessage = { role: string; content: string | OpenAiContentPart[] | null; tool_call_id?: string };
type Convert = (request: unknown) => AnyMessage[];

const proto = OpenAIContentGenerator.prototype as unknown as {
  convertToOpenAIFormat: Convert;
  __darhaiMediaPatched?: boolean;
};

const makeInstance = (): { convertToOpenAIFormat: Convert } => {
  const stubConfig = { getContentGeneratorConfig: () => ({}) };
  return new OpenAIContentGenerator('test-key', 'qwen3-vl-8b', stubConfig as never) as unknown as {
    convertToOpenAIFormat: Convert;
  };
};

const IMG = { inlineData: { mimeType: 'image/png', data: 'aW1n' } };
const VID = { inlineData: { mimeType: 'video/mp4', data: 'dmlk' } };

const plainMediaRequest = {
  contents: [{ role: 'user', parts: [{ text: 'What is in this picture?' }, IMG] }],
};

const toolMediaRequest = {
  contents: [
    { role: 'user', parts: [{ text: 'Read the screenshot' }] },
    { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'read_file', args: { path: 'shot.png' } } }] },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'call_1',
            name: 'read_file',
            response: { output: 'Binary content provided (1 item(s)).' },
          },
        },
        IMG,
      ],
    },
    // A trailing turn AFTER the tool result, so "injected right after the tool
    // message" and "appended at the very end" are DISTINGUISHABLE positions -
    // without this, breaking the after-tool injection would survive the test
    // because the leftover fallback lands in the same place.
    { role: 'model', parts: [{ text: 'Analysis follows.' }] },
  ],
};

const flatten = (messages: AnyMessage[]): string => JSON.stringify(messages);

// Captured BEFORE the patch is applied anywhere in this process.
let original: Convert;

beforeAll(() => {
  expect(proto.__darhaiMediaPatched).toBeFalsy();
  original = proto.convertToOpenAIFormat;
  expect(typeof original).toBe('function');
});

describe('baseline: vendored converter drops inlineData (the bug being fixed)', () => {
  it('a user message with an image loses the image entirely', () => {
    const instance = makeInstance();
    const messages = original.call(instance, plainMediaRequest) as AnyMessage[];
    expect(flatten(messages)).not.toContain('image_url');
    expect(flatten(messages)).not.toContain('aW1n');
  });

  it('tool-sibling media is also dropped', () => {
    const instance = makeInstance();
    const messages = original.call(instance, toolMediaRequest) as AnyMessage[];
    expect(flatten(messages)).not.toContain('aW1n');
  });
});

describe('patched converter', () => {
  beforeAll(() => {
    applyOpenAiMediaPatch();
    expect(proto.__darhaiMediaPatched).toBe(true);
  });

  it('is idempotent - applying twice does not double-wrap', () => {
    const wrapped = proto.convertToOpenAIFormat;
    applyOpenAiMediaPatch();
    expect(proto.convertToOpenAIFormat).toBe(wrapped);
  });

  it('image inlineData in a user message becomes an image_url content part', () => {
    const instance = makeInstance();
    const messages = instance.convertToOpenAIFormat(plainMediaRequest);
    const userMessage = messages.find((m) => m.role === 'user' && Array.isArray(m.content));
    expect(userMessage).toBeDefined();
    const parts = userMessage!.content as OpenAiContentPart[];
    expect(parts).toContainEqual({ type: 'text', text: 'What is in this picture?' });
    expect(parts).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n' } });
  });

  it('video inlineData becomes a video_url content part', () => {
    const instance = makeInstance();
    const messages = instance.convertToOpenAIFormat({
      contents: [{ role: 'user', parts: [{ text: 'Watch this clip' }, VID] }],
    });
    const parts = messages.find((m) => Array.isArray(m.content))?.content as OpenAiContentPart[];
    expect(parts).toContainEqual({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlk' } });
  });

  it('a media-only user message is NOT dropped as empty', () => {
    const instance = makeInstance();
    const messages = instance.convertToOpenAIFormat({
      contents: [{ role: 'user', parts: [IMG] }],
    });
    const parts = messages.find((m) => m.role === 'user' && Array.isArray(m.content))?.content as OpenAiContentPart[];
    expect(parts).toBeDefined();
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
  });

  it('tool-sibling media is injected as a user message right after its tool message', () => {
    const instance = makeInstance();
    const messages = instance.convertToOpenAIFormat(toolMediaRequest);
    const toolIndex = messages.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
    expect(toolIndex).toBeGreaterThan(-1);
    const next = messages[toolIndex + 1];
    expect(next?.role).toBe('user');
    const parts = next.content as OpenAiContentPart[];
    expect(parts.some((p) => p.type === 'image_url' && p.image_url.url === 'data:image/png;base64,aW1n')).toBe(true);
    // The media message must sit BETWEEN the tool message and the following
    // assistant turn - an end-of-array fallback placement is NOT acceptable.
    const followUp = messages[toolIndex + 2];
    expect(followUp?.role).toBe('assistant');
    expect(followUp?.content).toBe('Analysis follows.');
  });

  it('unsupported mimes (application/pdf) keep the dropped behaviour', () => {
    const instance = makeInstance();
    const messages = instance.convertToOpenAIFormat({
      contents: [
        { role: 'user', parts: [{ text: 'PDF here' }, { inlineData: { mimeType: 'application/pdf', data: 'cGRm' } }] },
      ],
    });
    expect(flatten(messages)).not.toContain('cGRm');
    // The text itself still goes through as a plain string message.
    expect(messages.some((m) => m.content === 'PDF here')).toBe(true);
  });

  it('requests without media take the untouched original path', () => {
    const instance = makeInstance();
    const messages = instance.convertToOpenAIFormat({
      contents: [{ role: 'user', parts: [{ text: 'just text' }] }],
    });
    expect(messages).toEqual([{ role: 'user', content: 'just text' }]);
  });
});

describe('pure helpers', () => {
  it('extractMedia never mutates the original request', () => {
    const request = { contents: [{ role: 'user', parts: [{ text: 'hi' }, { ...IMG }] }] };
    const snapshot = JSON.stringify(request);
    extractMedia(request);
    expect(JSON.stringify(request)).toBe(snapshot);
  });

  it('injectMedia strips a stray placeholder leaking into a non-user role', () => {
    const placeholders = new Map([[0, { mimeType: 'image/png', dataUrl: 'data:image/png;base64,aW1n' }]]);
    const result = injectMedia([{ role: 'assistant', content: 'echo [[DARHAI_MEDIA_0]]' }], placeholders, new Map());
    expect(result[0].content).toBe('echo');
  });

  it('injectMedia appends orphaned tool media at the end instead of losing it', () => {
    const toolMedia = new Map([['ghost', [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,aW1n' }]]]);
    const result = injectMedia([{ role: 'user', content: 'hi' }], new Map(), toolMedia);
    expect(result).toHaveLength(2);
    const parts = result[1].content as OpenAiContentPart[];
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
  });
});
