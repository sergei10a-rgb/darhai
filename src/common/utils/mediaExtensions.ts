/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Video file extensions recognised by the chat attachment pipeline.
 *
 * Lives in common/ because BOTH sides need the same list: the renderer's
 * paste/drop filter (FileService) and the main process' video-input handling
 * (videoFrames - frame extraction for models without native video support).
 */
export const videoExts = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];
