/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Media patch for the vendored aioncli `OpenAIContentGenerator`.
 *
 * Problem (measured): `convertToOpenAIFormat` recognises only text /
 * functionCall / functionResponse parts. Every `inlineData` part - the base64
 * image/video payload produced by the read_file tool (fileUtils.js
 * processSingleFileContent) - is SILENTLY DROPPED, so a model behind an
 * OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp, vLLM, DashScope,
 * OpenRouter, ...) never sees attached media; it only receives the
 * "Binary content provided (N item(s))." placeholder string. Gemini-native
 * requests are unaffected (inlineData passes through to @google/genai).
 *
 * Fix - wrap the prototype method; node_modules stays untouched:
 *  1. inlineData in ordinary contents is pre-replaced by a unique text
 *     placeholder so the original converter keeps the message (a media-only
 *     user message would otherwise be dropped as empty text), then each
 *     placeholder is expanded into an OpenAI content-part array entry:
 *       image/* -> { type: 'image_url', image_url: { url: <data URL> } }
 *       video/* -> { type: 'video_url', video_url: { url: <data URL> } }
 *     (`video_url` is the wire format both vLLM and DashScope
 *     compatible-mode accept for video-capable models.)
 *  2. inlineData riding NEXT TO a functionResponse (the lazy read_file path)
 *     cannot live inside the OpenAI `tool` message - tool messages are
 *     text-only - so it is injected as a separate `user` message immediately
 *     AFTER the matching tool message, matched by `tool_call_id` which
 *     survives the converter's cleanup/reordering passes untouched.
 *
 * Other mime types (audio/*, application/pdf) keep today's behaviour
 * (dropped) - they have no portable OpenAI-compat part format.
 *
 * The vendored dist is pinned; tests import the REAL class so a dependency
 * bump that changes the method shape this patch relies on fails loudly.
 */

import { OpenAIContentGenerator } from '@office-ai/aioncli-core/dist/src/core/openaiContentGenerator.js';

const PLACEHOLDER_RE = /\[\[DARHAI_MEDIA_(\d+)\]\]/g;

const placeholderFor = (index: number): string => `[[DARHAI_MEDIA_${index}]]`;

export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } };

type OpenAiMessage = {
  role: string;
  content: string | OpenAiContentPart[] | null;
  tool_call_id?: string;
  [key: string]: unknown;
};

type MediaRef = { mimeType: string; dataUrl: string };

type GeminiPart = {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  functionResponse?: { id?: string };
  [key: string]: unknown;
};

type GeminiContent = string | { role?: string; parts?: Array<string | GeminiPart> };

type GeminiRequest = {
  contents?: GeminiContent | GeminiContent[];
  [key: string]: unknown;
};

type ExtractResult = {
  request: GeminiRequest;
  /** placeholder index -> media, for media embedded in ordinary messages */
  placeholders: Map<number, MediaRef>;
  /** tool_call_id -> media list, for media riding next to a functionResponse */
  toolMedia: Map<string, MediaRef[]>;
};

const toMediaRef = (part: GeminiPart): MediaRef | null => {
  const mimeType = part.inlineData?.mimeType;
  const data = part.inlineData?.data;
  if (!mimeType || !data) return null;
  if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) return null;
  return { mimeType, dataUrl: `data:${mimeType};base64,${data}` };
};

const toContentPart = (ref: MediaRef): OpenAiContentPart =>
  ref.mimeType.startsWith('video/')
    ? { type: 'video_url', video_url: { url: ref.dataUrl } }
    : { type: 'image_url', image_url: { url: ref.dataUrl } };

/**
 * Walk the request and lift out supported inlineData parts. Returns a new
 * request (originals are never mutated) plus the two media indexes.
 */
export function extractMedia(request: GeminiRequest): ExtractResult {
  const placeholders = new Map<number, MediaRef>();
  const toolMedia = new Map<string, MediaRef[]>();
  let nextIndex = 0;

  const transformContent = (content: GeminiContent): GeminiContent => {
    if (typeof content === 'string' || !Array.isArray(content.parts)) return content;

    const hasInline = content.parts.some((p) => typeof p !== 'string' && toMediaRef(p) !== null);
    if (!hasInline) return content;

    // Media next to a functionResponse cannot ride the text-only OpenAI tool
    // message - collect it under the response id for post-injection instead.
    const responsePart = content.parts.find(
      (p): p is GeminiPart => typeof p !== 'string' && p.functionResponse !== undefined
    );
    const toolCallId = responsePart?.functionResponse?.id ?? '';

    const newParts: Array<string | GeminiPart> = [];
    for (const part of content.parts) {
      const ref = typeof part === 'string' ? null : toMediaRef(part);
      if (!ref) {
        newParts.push(part);
        continue;
      }
      if (responsePart) {
        const list = toolMedia.get(toolCallId) ?? [];
        toolMedia.set(toolCallId, [...list, ref]);
        // Drop the part - the converter would ignore it in this branch anyway.
      } else {
        const index = nextIndex++;
        placeholders.set(index, ref);
        newParts.push({ text: placeholderFor(index) });
      }
    }
    return { ...content, parts: newParts };
  };

  const contents = request.contents;
  let newContents: GeminiContent | GeminiContent[] | undefined;
  if (Array.isArray(contents)) {
    newContents = contents.map(transformContent);
  } else if (contents !== undefined) {
    newContents = transformContent(contents);
  }

  return {
    request: newContents === undefined ? request : { ...request, contents: newContents },
    placeholders,
    toolMedia,
  };
}

/** Expand placeholder tokens inside one user-message string into content parts. */
const expandPlaceholders = (content: string, placeholders: Map<number, MediaRef>): string | OpenAiContentPart[] => {
  PLACEHOLDER_RE.lastIndex = 0;
  if (!PLACEHOLDER_RE.test(content)) return content;

  const parts: OpenAiContentPart[] = [];
  let last = 0;
  let sawMedia = false;
  PLACEHOLDER_RE.lastIndex = 0;
  for (const match of content.matchAll(PLACEHOLDER_RE)) {
    const ref = placeholders.get(Number(match[1]));
    if (!ref) continue; // Foreign token that merely looks like ours - leave it in the text.
    const before = content.slice(last, match.index).trim();
    if (before) parts.push({ type: 'text', text: before });
    parts.push(toContentPart(ref));
    sawMedia = true;
    last = (match.index ?? 0) + match[0].length;
  }
  if (!sawMedia) return content;
  const tail = content.slice(last).trim();
  if (tail) parts.push({ type: 'text', text: tail });
  return parts;
};

/**
 * Post-process the converter's output: expand placeholders and re-attach
 * tool-result media as user messages following their tool message.
 */
export function injectMedia(
  messages: OpenAiMessage[],
  placeholders: Map<number, MediaRef>,
  toolMedia: Map<string, MediaRef[]>
): OpenAiMessage[] {
  const pending = new Map(toolMedia);
  const result: OpenAiMessage[] = [];

  const mediaMessage = (refs: MediaRef[]): OpenAiMessage => ({
    role: 'user',
    content: [{ type: 'text', text: '[Media from the tool result above]' }, ...refs.map(toContentPart)],
  });

  for (const message of messages) {
    let next = message;
    if (message.role === 'user' && typeof message.content === 'string') {
      const expanded = expandPlaceholders(message.content, placeholders);
      if (expanded !== message.content) next = { ...message, content: expanded };
    } else if (message.role !== 'user' && typeof message.content === 'string') {
      // A placeholder can only legitimately appear in user text; strip strays
      // so an internal token never leaks to the provider from other roles.
      PLACEHOLDER_RE.lastIndex = 0;
      if (PLACEHOLDER_RE.test(message.content)) {
        next = { ...message, content: message.content.replace(PLACEHOLDER_RE, '').trim() };
      }
    }
    result.push(next);

    if (message.role === 'tool') {
      const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      const refs = pending.get(id);
      if (refs && refs.length > 0) {
        result.push(mediaMessage(refs));
        pending.delete(id);
      }
    }
  }

  // Tool messages culled by the converter's orphan cleanup would strand their
  // media - better late than lost: append what remains as one user message.
  const leftovers = [...pending.values()].flat();
  if (leftovers.length > 0) result.push(mediaMessage(leftovers));

  return result;
}

type PatchableProto = {
  convertToOpenAIFormat?: (request: GeminiRequest) => OpenAiMessage[];
  __darhaiMediaPatched?: boolean;
};

/**
 * Install the wrapper. Idempotent; degrades to a loud no-op if the vendored
 * class no longer exposes the expected method.
 */
export function applyOpenAiMediaPatch(): void {
  const proto = OpenAIContentGenerator.prototype as unknown as PatchableProto;
  if (proto.__darhaiMediaPatched) return;

  const original = proto.convertToOpenAIFormat;
  if (typeof original !== 'function') {
    console.error(
      '[openaiMediaPatch] OpenAIContentGenerator.convertToOpenAIFormat is missing - vendored layout changed, media patch NOT applied'
    );
    return;
  }

  proto.convertToOpenAIFormat = function (this: unknown, request: GeminiRequest): OpenAiMessage[] {
    try {
      const { request: cleaned, placeholders, toolMedia } = extractMedia(request);
      if (placeholders.size === 0 && toolMedia.size === 0) {
        return original.call(this, request);
      }
      const messages = original.call(this, cleaned);
      return injectMedia(messages, placeholders, toolMedia);
    } catch (error) {
      console.error('[openaiMediaPatch] media injection failed, falling back to original conversion:', error);
      return original.call(this, request);
    }
  };
  proto.__darhaiMediaPatched = true;
}
