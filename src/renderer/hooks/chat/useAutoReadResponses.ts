/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * App-wide auto-read: when `tools.textToSpeech` has `enabled` AND
 * `autoReadResponses` on, every finished assistant reply is spoken through
 * the local TTS engine (`voiceSynth.speak`).
 *
 * Mounted ONCE in Layout (the useDeepLink / useNotificationClick pattern).
 * It listens on the unified `conversation.responseStream` wire, which every
 * chat platform's turn events travel over: `content` frames are text deltas
 * for the assistant bubble, and `finish` marks the end of the turn - the
 * point picked for reading, because speaking half-typed sentences during
 * streaming is noise, and `conversation.turnCompleted` (the other candidate)
 * carries no message text at all.
 *
 * Consecutive replies interrupt: `speakText` routes through the app-wide
 * singleton player, so a new turn's audio replaces the previous one.
 */

import { useEffect, useRef } from 'react';
import { Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { getTtsConfig } from '@/renderer/services/voice/ttsConfig';
import {
  TTS_MAX_SPEAK_CHARS,
  prepareTextForSpeech,
  speakText,
  ttsErrorMessageKey,
} from '@/renderer/services/voice/ttsPlayback';

/**
 * Cap on the per-conversation accumulation buffer. Markdown stripping can only
 * SHRINK text and speaking clamps to TTS_MAX_SPEAK_CHARS, so raw text beyond
 * this margin can never be heard - dropping it keeps a very long reply from
 * ballooning renderer memory for nothing.
 */
const RAW_BUFFER_CAP = TTS_MAX_SPEAK_CHARS * 4;

/** The text of a `content` frame; '' for shapes that carry none. */
const contentChunkOf = (data: unknown): string => {
  if (typeof data === 'string') return data;
  if (data !== null && typeof data === 'object') {
    const content = (data as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return '';
};

export const useAutoReadResponses = (): void => {
  const { t } = useTranslation();
  // Per-conversation raw text of the CURRENT turn, cleared on finish.
  const buffersRef = useRef(new Map<string, string>());
  // Last toasted error key: auto-read runs after every turn, and repeating
  // the same "voice not installed" toast on each reply is spam. A DIFFERENT
  // failure (or a success) re-arms the toast.
  const lastErrorKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const off = ipcBridge.conversation.responseStream.on((message) => {
      if (message.type === 'content') {
        const chunk = contentChunkOf(message.data);
        if (chunk === '') return;
        const buffers = buffersRef.current;
        const prev = buffers.get(message.conversation_id) ?? '';
        if (prev.length < RAW_BUFFER_CAP) {
          buffers.set(message.conversation_id, prev + chunk);
        }
        return;
      }

      if (message.type !== 'finish') return;
      const raw = buffersRef.current.get(message.conversation_id) ?? '';
      buffersRef.current.delete(message.conversation_id);
      if (raw.trim() === '') return;

      void (async () => {
        try {
          const config = await getTtsConfig();
          if (config.enabled !== true || config.autoReadResponses !== true) return;
          const speakable = prepareTextForSpeech(raw);
          if (speakable === '') return;
          await speakText(speakable);
          lastErrorKeyRef.current = null;
        } catch (err) {
          const key = ttsErrorMessageKey(err);
          if (key !== lastErrorKeyRef.current) {
            lastErrorKeyRef.current = key;
            Message.warning(t(key));
          }
        }
      })();
    });
    return off;
  }, [t]);
};
