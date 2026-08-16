/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-side playback for the `voiceSynth` IPC surface: sends text to the
 * main-process TTS engine (kitten-mn by default) and plays the returned bytes
 * through ONE app-wide HTMLAudioElement. A module-level singleton is the
 * point, not a shortcut - auto-read, the per-message read-aloud button, and
 * the settings test button must interrupt each other instead of talking over
 * one another.
 *
 * Also owns the text preparation (markdown strip + length clamp - kitten's
 * server rejects over-long text with HTTP 413) and the mapping from the typed
 * error codes the voice services throw to i18n message keys, so every surface
 * shows the same localized message for the same failure.
 */

import { voiceSynth } from '@/common/adapter/ipcBridge';

/**
 * Longest text one speak call sends. The kitten-mn bundle enforces its own
 * `max_chars` with HTTP 413 (KITTEN_MN_TEXT_TOO_LONG); clamping here keeps a
 * long chat reply from turning auto-read into an error toast.
 */
export const TTS_MAX_SPEAK_CHARS = 3000;

/**
 * Strip markdown mechanics a listener should not hear. Deliberately simple
 * line-oriented regexes, not a parser: code BLOCKS are dropped whole (their
 * body is noise when spoken), inline code / links keep their visible text,
 * heading-list-emphasis markers are removed. Imperfect stripping is fine -
 * the goal is "does not read three backticks aloud", not markdown fidelity.
 */
export const stripMarkdownForSpeech = (markdown: string): string => {
  let text = markdown;
  // Fenced code blocks first, so their content never reaches later rules.
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ');
  // Images vanish; links keep the label; inline code keeps its content.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');
  text = text.replace(/`([^`]*)`/g, '$1');
  // Line-start mechanics: headings, blockquotes, list bullets, rules.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');
  text = text.replace(/^\s{0,3}(?:[-*_]\s?){3,}\s*$/gm, ' ');
  // Emphasis / strikethrough markers anywhere.
  text = text.replace(/(\*\*|__|~~|[*_])/g, '');
  // Collapse the whitespace the removals leave behind.
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

/** Markdown-stripped text clamped to what one speak call may carry. */
export const prepareTextForSpeech = (markdown: string): string =>
  stripMarkdownForSpeech(markdown).slice(0, TTS_MAX_SPEAK_CHARS).trim();

/**
 * Typed voice error code -> i18n key. Codes travel as the MESSAGE PREFIX of
 * errors thrown across IPC (`${code}: ${detail}`, see KittenTtsServer /
 * TextToSpeechService), so matching on the serialized message is the stable
 * contract, not instanceof.
 */
const TTS_ERROR_KEY_BY_CODE: ReadonlyArray<readonly [code: string, i18nKey: string]> = [
  ['KITTEN_MN_NOT_INSTALLED', 'conversation.chat.tts.notInstalled'],
  ['KITTEN_MN_TEXT_TOO_LONG', 'conversation.chat.tts.textTooLong'],
  ['KITTEN_MN_START_TIMEOUT', 'conversation.chat.tts.startTimeout'],
  ['KITTEN_MN_START_FAILED', 'conversation.chat.tts.startFailed'],
  ['KITTEN_MN_BUNDLE_INVALID', 'conversation.chat.tts.startFailed'],
  ['KITTEN_MN_REQUEST_FAILED', 'conversation.chat.tts.requestFailed'],
  ['TTS_KOKORO_REMOVED', 'conversation.chat.tts.kokoroRemoved'],
  ['TTS_SYSTEM_NATIVE_UNSUPPORTED', 'conversation.chat.tts.systemNativeUnsupported'],
];

/** The i18n key for a TTS failure; a generic key when the code is unknown. */
export const ttsErrorMessageKey = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  for (const [code, key] of TTS_ERROR_KEY_BY_CODE) {
    if (message.includes(code)) return key;
  }
  return 'conversation.chat.tts.genericError';
};

type ActivePlayback = {
  audio: HTMLAudioElement;
  url: string;
};

let active: ActivePlayback | null = null;

const playbackStoppedListeners = new Set<() => void>();

/**
 * Subscribe to "the active clip stopped" - ended naturally, errored, was
 * interrupted by a newer clip, or was stopped explicitly. Lets per-message
 * read-aloud buttons drop their "speaking" state without polling. Returns the
 * unsubscribe function.
 */
export const onTtsPlaybackStopped = (listener: () => void): (() => void) => {
  playbackStoppedListeners.add(listener);
  return () => {
    playbackStoppedListeners.delete(listener);
  };
};

const notifyPlaybackStopped = (): void => {
  // Direct Set iteration: a listener unsubscribing ITSELF mid-notification is
  // safe (deleting the current element does not break Set iteration).
  for (const listener of playbackStoppedListeners) listener();
};

/** True while the app-wide TTS audio element is playing (or paused mid-clip). */
export const isTtsPlaying = (): boolean => active !== null;

/** Stop and release the current playback. Safe when nothing is playing. */
export const stopTtsPlayback = (): void => {
  if (active === null) return;
  const { audio, url } = active;
  // Clearing `active` FIRST makes the end/error listeners no-ops (they guard
  // on identity), so a late 'ended' cannot double-revoke the URL.
  active = null;
  try {
    audio.pause();
  } catch {
    // Already torn down - releasing the URL below is what matters.
  }
  URL.revokeObjectURL(url);
  notifyPlaybackStopped();
};

/**
 * Play one synthesized clip, interrupting whatever was playing. Resolves once
 * playback has STARTED (long clips should not hold callers hostage); the
 * object URL is revoked when the clip ends, errors, or is interrupted.
 */
export const playTtsBytes = async (data: number[], mimeType: string): Promise<void> => {
  stopTtsPlayback();
  const blob = new Blob([new Uint8Array(data)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const entry: ActivePlayback = { audio, url };
  active = entry;
  const release = (): void => {
    if (active === entry) {
      active = null;
      URL.revokeObjectURL(url);
      notifyPlaybackStopped();
    }
  };
  audio.addEventListener('ended', release, { once: true });
  audio.addEventListener('error', release, { once: true });
  try {
    await audio.play();
  } catch (err) {
    release();
    throw err;
  }
};

/**
 * Synthesize `text` with the configured main-process TTS engine and play the
 * result. The text is sent AS GIVEN - callers that read chat markdown must
 * run {@link prepareTextForSpeech} first. Throws the bridge's typed errors;
 * map them with {@link ttsErrorMessageKey} for display.
 */
export const speakText = async (text: string): Promise<void> => {
  const { data, mimeType } = await voiceSynth.speak.invoke({ text });
  await playTtsBytes(data, mimeType);
};
