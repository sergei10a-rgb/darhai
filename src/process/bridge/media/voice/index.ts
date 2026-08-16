/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The speech surfaces: transcription in, synthesis out, and the asset manager
 * that downloads and verifies the model files both of them need before either
 * can run. `SpeechToTextService` is the transcription engine itself and lives
 * beside its bridge because the web server route is its only other caller.
 * They are split out from `../` because voice has a dependency the preview
 * bridges do not - downloaded model weights with pinned checksums - and that
 * lifecycle is what this directory is about.
 */

export * from './SpeechToTextService';
export * from './mongolVoiceBridge';
export * from './speechToTextBridge';
export * from './voiceAssetBridge';
export * from './voiceSynthBridge';
