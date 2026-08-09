/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Video -> frame extraction for chat attachments (the "Б" path).
 *
 * A video attached to a conversation whose model has no native video input is
 * sampled into a handful of JPEG frames; the frames ride the ordinary image
 * channel, so ANY vision model behind ANY endpoint (Ollama, LM Studio,
 * llama.cpp, wcore engine, ...) can "watch" the video. Models WITH native
 * video capability keep the original file (the "А" path) and receive it as an
 * inline video / video_url part instead.
 *
 * ffmpeg is resolved from PATH only - the repo's precedents (cloudflared,
 * whisper-cli, officecli) all avoid bundling large binaries; a missing ffmpeg
 * degrades to a visible notice, never a blocked send.
 *
 * Frames are written under `<cacheDir>/temp/` - the send path already knows
 * that location: the Gemini flow copies them into the workspace and deletes
 * the temp originals; other flows use them in place like any other cache-temp
 * upload.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { videoExts } from '@/common/utils/mediaExtensions';
import { getSystemDir } from '@process/utils/initStorage';
import { safeExecFile } from '@process/utils/safeExec';

export type VideoFrameErrorCode = 'ffmpeg-missing' | 'video-too-large' | 'extract-failed';

export class VideoFrameError extends Error {
  constructor(
    public readonly code: VideoFrameErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'VideoFrameError';
  }
}

const FRAME_COUNT_DEFAULT = 8;
const FRAME_COUNT_MIN = 1;
const FRAME_COUNT_MAX = 32;
const VIDEO_MAX_MB_DEFAULT = 1024;
const EXTRACT_TIMEOUT_MS_DEFAULT = 120_000;
const PROBE_TIMEOUT_MS = 30_000;
/** Frames are capped to this width - enough for VLM input, cheap on tokens. */
const FRAME_MAX_WIDTH = 1024;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const readPositiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const isVideoFilePath = (filePath: string): boolean => videoExts.includes(path.extname(filePath).toLowerCase());

let cachedFfmpegPath: string | null | undefined;

/**
 * PATH-only ffmpeg resolution (`where` on Windows, `which` elsewhere),
 * following binaryResolver's pattern. `where` may print several matches -
 * only the first line is the effective one.
 */
export function resolveFfmpegBinary(): string | null {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const output = execFileSync(lookup, ['ffmpeg'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const first = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    cachedFfmpegPath = first ?? null;
  } catch {
    cachedFfmpegPath = null;
  }
  return cachedFfmpegPath;
}

/** Test seam: reset the memoized ffmpeg location. */
export const resetFfmpegCache = (): void => {
  cachedFfmpegPath = undefined;
};

/** Parse `Duration: 00:01:23.45` out of ffmpeg's stderr banner. */
export const parseDurationSeconds = (ffmpegStderr: string): number | null => {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(ffmpegStderr);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};

type ExecFn = typeof safeExecFile;

export type ExtractOptions = {
  /** Test seams - default to the real implementations. */
  execFile?: ExecFn;
  ffmpegPath?: string | null;
  outputRoot?: string;
  maxFrames?: number;
  maxMb?: number;
  timeoutMs?: number;
};

export type ExtractResult = {
  frameDir: string;
  frames: string[];
};

/**
 * Sample a video into at most N evenly spaced JPEG frames named
 * `<video-base>_frame_NNN.jpg` so the file names alone tell the model what
 * they are. Throws VideoFrameError; on failure its own partial output is
 * removed.
 */
export async function extractVideoFrames(videoPath: string, options: ExtractOptions = {}): Promise<ExtractResult> {
  const execFile = options.execFile ?? safeExecFile;
  const maxMb = options.maxMb ?? readPositiveIntEnv('DARHAI_VIDEO_MAX_MB', VIDEO_MAX_MB_DEFAULT);
  const maxFrames = clamp(
    options.maxFrames ?? readPositiveIntEnv('DARHAI_VIDEO_MAX_FRAMES', FRAME_COUNT_DEFAULT),
    FRAME_COUNT_MIN,
    FRAME_COUNT_MAX
  );
  const timeoutMs = options.timeoutMs ?? readPositiveIntEnv('DARHAI_VIDEO_EXTRACT_TIMEOUT_MS', EXTRACT_TIMEOUT_MS_DEFAULT);

  const stat = await fs.stat(videoPath).catch((): null => null);
  if (!stat || !stat.isFile()) {
    throw new VideoFrameError('extract-failed', `video not found: ${videoPath}`);
  }
  if (stat.size > maxMb * 1024 * 1024) {
    throw new VideoFrameError('video-too-large', `video exceeds ${maxMb}MB: ${videoPath}`);
  }

  const ffmpegPath = options.ffmpegPath !== undefined ? options.ffmpegPath : resolveFfmpegBinary();
  if (!ffmpegPath) {
    throw new VideoFrameError('ffmpeg-missing', 'ffmpeg was not found on PATH');
  }

  // Probe the duration. `ffmpeg -i <file>` exits non-zero by design (no
  // output specified) - the banner we need is on stderr either way.
  let duration: number | null = null;
  try {
    const probe = await execFile(ffmpegPath, ['-hide_banner', '-i', videoPath], { timeout: PROBE_TIMEOUT_MS });
    duration = parseDurationSeconds(probe.stderr);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    if (typeof stderr === 'string') duration = parseDurationSeconds(stderr);
  }

  const baseName = path
    .basename(videoPath, path.extname(videoPath))
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .slice(0, 60);
  const outputRoot = options.outputRoot ?? path.join(getSystemDir().cacheDir, 'temp');
  const frameDir = await fs.mkdtemp(path.join(outputRoot, `video-frames-${baseName}-`));

  // Evenly spread `maxFrames` samples across the clip; without a known
  // duration fall back to one frame every 2 seconds. `min(W,iw)` never
  // upscales; `-2` keeps the height even as JPEG requires.
  const fpsExpr = duration ? `${maxFrames}/${duration.toFixed(3)}` : '1/2';
  const filter = `fps=${fpsExpr},scale=min(${FRAME_MAX_WIDTH}\\,iw):-2`;
  const outputPattern = path.join(frameDir, `${baseName}_frame_%03d.jpg`);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    videoPath,
    '-vf',
    filter,
    '-frames:v',
    String(maxFrames),
    '-q:v',
    '5',
    '-y',
    outputPattern,
  ];

  try {
    await execFile(ffmpegPath, args, { timeout: timeoutMs });
  } catch (error) {
    await fs.rm(frameDir, { recursive: true, force: true }).catch(() => {});
    const detail = (error as { stderr?: string }).stderr || (error as Error).message;
    throw new VideoFrameError('extract-failed', `ffmpeg failed for ${videoPath}: ${detail}`);
  }

  const entries = await fs.readdir(frameDir).catch(() => [] as string[]);
  const frames = entries
    .filter((name) => name.endsWith('.jpg'))
    .sort()
    .map((name) => path.join(frameDir, name));
  if (frames.length === 0) {
    await fs.rm(frameDir, { recursive: true, force: true }).catch(() => {});
    throw new VideoFrameError('extract-failed', `ffmpeg produced no frames for ${videoPath}`);
  }

  return { frameDir, frames };
}

export type PrepareResult = {
  /** The send-ready file list: videos replaced by their frames when needed. */
  files: string[];
  /** Mongolian, user-facing - one entry per video that could not be prepared. */
  notices: string[];
};

const noticeFor = (fileName: string, error: unknown): string => {
  if (error instanceof VideoFrameError) {
    if (error.code === 'ffmpeg-missing') {
      return `«${fileName}» видеог фрэйм болгон задалж чадсангүй: ffmpeg суугаагүй байна. ffmpeg.org-оос суулгасны дараа энэ загвар видеог «үзэж» чадна.`;
    }
    if (error.code === 'video-too-large') {
      return `«${fileName}» видео хэт том тул фрэйм болгон задалсангүй.`;
    }
  }
  return `«${fileName}» видеог фрэйм болгон задлахад алдаа гарлаа.`;
};

/**
 * Rewrite a send's attachment list for video input.
 *
 * - model with native video support -> videos pass through untouched (А);
 * - otherwise -> each video is replaced by its extracted frames (Б), and a
 *   failed extraction keeps the original file plus returns a user notice so
 *   the degradation is never silent.
 */
export async function prepareVideoAttachments(
  files: string[],
  supportsVideo: boolean,
  options: ExtractOptions = {}
): Promise<PrepareResult> {
  const hasVideo = files.some(isVideoFilePath);
  if (!hasVideo || supportsVideo) return { files, notices: [] };

  const prepared: string[] = [];
  const notices: string[] = [];
  for (const file of files) {
    if (!isVideoFilePath(file)) {
      prepared.push(file);
      continue;
    }
    try {
      const { frames } = await extractVideoFrames(file, options);
      prepared.push(...frames);
      console.log(`[videoFrames] ${path.basename(file)} -> ${frames.length} frame(s)`);
    } catch (error) {
      console.warn(`[videoFrames] extraction failed for ${file}:`, error);
      prepared.push(file);
      notices.push(noticeFor(path.basename(file), error));
    }
  }
  return { files: prepared, notices };
}
