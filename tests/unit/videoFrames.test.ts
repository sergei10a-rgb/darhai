/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Video -> frame extraction (the Б path). All ffmpeg interaction goes through
 * injected seams, so these tests pin: duration parsing, the А/Б routing rules
 * of prepareVideoAttachments, error mapping to typed codes, partial-output
 * cleanup, and that a failed extraction degrades to the original file plus a
 * Mongolian notice instead of a blocked send.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('@process/utils/initStorage', () => ({
  getSystemDir: () => ({ cacheDir: os.tmpdir() }),
}));

// eslint-disable-next-line import/first
import {
  extractVideoFrames,
  isVideoFilePath,
  parseDurationSeconds,
  prepareVideoAttachments,
  resolveFfmpegBinary,
  VideoFrameError,
} from '@process/services/video/videoFrames';
// eslint-disable-next-line import/first
import { safeExecFile } from '@process/utils/safeExec';

let scratch: string;
let videoPath: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'darhai-videoframes-'));
  videoPath = path.join(scratch, 'clip.mp4');
  await fs.writeFile(videoPath, Buffer.alloc(1024, 1));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
});

type ExecCall = { file: string; args: string[] };

/** Probe rejects like real `ffmpeg -i` (no output file), extract writes frames. */
const makeExec = (calls: ExecCall[], frameCount = 3, failExtract = false) =>
  vi.fn(async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (!args.includes('-vf')) {
      const err = Object.assign(new Error('no output specified'), {
        stderr: 'Input #0\n  Duration: 00:00:10.00, start: 0.0, bitrate: 1 kb/s',
      });
      throw err;
    }
    if (failExtract) {
      throw Object.assign(new Error('boom'), { stderr: 'Invalid data found' });
    }
    const pattern = args[args.length - 1];
    const dir = path.dirname(pattern);
    for (let i = 1; i <= frameCount; i++) {
      await fs.writeFile(path.join(dir, `clip_frame_${String(i).padStart(3, '0')}.jpg`), Buffer.alloc(8));
    }
    return { stdout: '', stderr: '' };
  });

describe('parseDurationSeconds', () => {
  it('parses the ffmpeg banner duration', () => {
    expect(parseDurationSeconds('  Duration: 00:01:30.50, start: 0')).toBeCloseTo(90.5);
  });
  it('returns null for missing or zero duration', () => {
    expect(parseDurationSeconds('no banner here')).toBeNull();
    expect(parseDurationSeconds('Duration: 00:00:00.00')).toBeNull();
  });
});

describe('isVideoFilePath', () => {
  it('recognises video extensions case-insensitively and rejects others', () => {
    expect(isVideoFilePath('C:/a/b/movie.MP4')).toBe(true);
    expect(isVideoFilePath('/x/clip.webm')).toBe(true);
    expect(isVideoFilePath('/x/photo.png')).toBe(false);
  });
});

describe('extractVideoFrames', () => {
  it('samples frames named after the source video', async () => {
    const calls: ExecCall[] = [];
    const result = await extractVideoFrames(videoPath, {
      execFile: makeExec(calls) as never,
      ffmpegPath: '/fake/ffmpeg',
      outputRoot: scratch,
    });
    expect(result.frames).toHaveLength(3);
    expect(path.basename(result.frames[0])).toBe('clip_frame_001.jpg');
    // Extraction call carries an even-spread fps filter built from the probed duration.
    const extract = calls.find((c) => c.args.includes('-vf'));
    expect(extract?.args[extract.args.indexOf('-vf') + 1]).toContain('/10.000');
  });

  it('throws ffmpeg-missing when no binary is available', async () => {
    await expect(extractVideoFrames(videoPath, { ffmpegPath: null, outputRoot: scratch })).rejects.toMatchObject({
      code: 'ffmpeg-missing',
    });
  });

  it('throws video-too-large past the size cap', async () => {
    await expect(
      extractVideoFrames(videoPath, { ffmpegPath: '/fake/ffmpeg', outputRoot: scratch, maxMb: 0 })
    ).rejects.toMatchObject({ code: 'video-too-large' });
  });

  it('cleans up its partial output directory when ffmpeg fails', async () => {
    const calls: ExecCall[] = [];
    await expect(
      extractVideoFrames(videoPath, {
        execFile: makeExec(calls, 0, true) as never,
        ffmpegPath: '/fake/ffmpeg',
        outputRoot: scratch,
      })
    ).rejects.toMatchObject({ code: 'extract-failed' });
    const leftovers = (await fs.readdir(scratch)).filter((name) => name.startsWith('video-frames-'));
    expect(leftovers).toHaveLength(0);
  });
});

describe('prepareVideoAttachments (А/Б routing)', () => {
  it('leaves everything untouched when there is no video', async () => {
    const files = ['/a/photo.png', '/a/notes.txt'];
    const result = await prepareVideoAttachments(files, false, { ffmpegPath: null });
    expect(result.files).toEqual(files);
    expect(result.notices).toEqual([]);
  });

  it('А: a video-capable model receives the original video file', async () => {
    const result = await prepareVideoAttachments([videoPath], true, { ffmpegPath: null });
    expect(result.files).toEqual([videoPath]);
    expect(result.notices).toEqual([]);
  });

  it('Б: a non-video model gets the video replaced by frames, other files kept', async () => {
    const calls: ExecCall[] = [];
    const result = await prepareVideoAttachments(['/a/photo.png', videoPath], false, {
      execFile: makeExec(calls) as never,
      ffmpegPath: '/fake/ffmpeg',
      outputRoot: scratch,
    });
    expect(result.files[0]).toBe('/a/photo.png');
    expect(result.files.slice(1)).toHaveLength(3);
    expect(result.files[1].endsWith('clip_frame_001.jpg')).toBe(true);
    expect(result.notices).toEqual([]);
  });

  it('degrades loudly: failed extraction keeps the video and returns a Mongolian notice', async () => {
    const result = await prepareVideoAttachments([videoPath], false, {
      ffmpegPath: null,
      outputRoot: scratch,
    });
    expect(result.files).toEqual([videoPath]);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain('ffmpeg');
    expect(result.notices[0]).toContain('видео');
  });
});

describe('VideoFrameError', () => {
  it('carries a stable typed code', () => {
    const error = new VideoFrameError('ffmpeg-missing', 'x');
    expect(error.code).toBe('ffmpeg-missing');
    expect(error.name).toBe('VideoFrameError');
  });
});

// Real-ffmpeg smoke: proves the actual argument construction (fps filter,
// scale expression, output pattern) against a REAL binary, not a mock. Skips
// cleanly where ffmpeg is not installed (mirrors the DB-suite local gating).
const realFfmpeg = resolveFfmpegBinary();
describe.skipIf(!realFfmpeg)('real ffmpeg smoke', () => {
  it(
    'extracts non-empty frames from a generated test clip',
    async () => {
      const clip = path.join(scratch, 'testsrc.mp4');
      await safeExecFile(realFfmpeg!, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=4:size=320x240:rate=10',
        '-y',
        clip,
      ]);
      const { frames } = await extractVideoFrames(clip, { outputRoot: scratch, maxFrames: 4 });
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.length).toBeLessThanOrEqual(4);
      for (const frame of frames) {
        const stat = await fs.stat(frame);
        expect(stat.size).toBeGreaterThan(0);
      }
    },
    60_000
  );
});
