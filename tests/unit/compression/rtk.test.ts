/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for RTK (terminal/tool-output noise removal). Pure functions, no
 * mocks. Lives in tests/unit/ because vitest.config only includes tests/unit/**
 * for the node project.
 */

import { describe, it, expect } from 'vitest';
import { rtk, rtkLossless, stripAnsi } from '@process/services/compression/rtk';

const ESC = String.fromCharCode(0x1b);

describe('stripAnsi', () => {
  it('removes CSI colour and cursor sequences', () => {
    const input = `${ESC}[31mred${ESC}[0m ${ESC}[2K${ESC}[1Gline`;
    const out = stripAnsi(input);
    expect(out).toBe('red line');
    expect(out).not.toContain(ESC);
  });

  it('is a no-op on text with no escapes', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('rtk', () => {
  it('strips ANSI, spinner, and progress noise but keeps errors and summaries', () => {
    const spinner = '⠇';
    const input = [
      `${ESC}[32mBuilding...${ESC}[0m`,
      `${spinner} compiling module A`,
      'Downloading  10%\rDownloading  50%\rDownloading 100%',
      '[####------] 40%',
      '',
      '',
      '',
      'Error: could not resolve import "foo"',
      '  at resolve (loader.js:20)',
      'Summary: 3 passed, 1 failed',
    ].join('\n');

    const out = rtk(input);

    expect(out).not.toContain(ESC); // ANSI gone
    expect(out).not.toContain('compiling module A'); // spinner line dropped
    expect(out).toContain('Downloading 100%'); // progress redraw collapsed to last frame
    expect(out).not.toContain('Downloading  10%');
    expect(out).not.toContain('[####------] 40%'); // ascii progress bar dropped
    expect(out).toContain('Error: could not resolve import "foo"'); // error preserved
    expect(out).toContain('at resolve (loader.js:20)'); // stack frame preserved
    expect(out).toContain('Summary: 3 passed, 1 failed'); // summary preserved
    expect(out).not.toMatch(/\n{3,}/); // blank runs collapsed
  });

  it('collapses box-drawing borders and block progress bars', () => {
    const input = ['┌───┐', 'content line', '███░░ 60'].join('\n');
    const out = rtk(input);
    expect(out).toContain('content line');
    expect(out).not.toContain('┌');
    expect(out).not.toContain('█');
  });

  it('preserves a warning line even though it mentions a percentage', () => {
    expect(rtk('warning: 90% of disk used')).toContain('warning: 90% of disk used');
  });

  it('is idempotent', () => {
    const input = `${ESC}[31mx${ESC}[0m\n⠇ spin\n\n\n\ndone: ok`;
    const once = rtk(input);
    expect(rtk(once)).toBe(once);
  });
});

describe('rtkLossless', () => {
  it('strips ANSI and trailing whitespace without removing a visible glyph', () => {
    const input = `${ESC}[33mhello${ESC}[0m   \nworld\t\n`;
    const out = rtkLossless(input);
    expect(out).not.toContain(ESC);
    expect(out).toBe('hello\nworld\n');
  });

  it('preserves the non-whitespace character sequence exactly (lossless)', () => {
    const input = `${ESC}[31mconst x = 1;${ESC}[0m   \n\n\n\nreturn x;`;
    const ansiStripped = input.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
    expect(rtkLossless(input).replace(/\s+/g, '')).toBe(ansiStripped.replace(/\s+/g, ''));
  });

  it('is a no-op on clean text and idempotent', () => {
    const clean = 'const x = 1;\nreturn x;';
    expect(rtkLossless(clean)).toBe(clean);
    const out = rtkLossless(`${ESC}[31mx${ESC}[0m  \n\n\n\ny`);
    expect(rtkLossless(out)).toBe(out);
  });
});
