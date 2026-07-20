/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { normalizeAcp, normalizeWcore } from '@process/agent/guard/normalize';
import { evaluate } from '@process/agent/guard/HookGuardService';

describe('normalizeAcp', () => {
  it('maps title -> toolName and pulls command/file_path/content from rawInput', () => {
    const n = normalizeAcp({
      toolCallId: 't1',
      title: 'run_shell',
      kind: 'execute',
      rawInput: { command: 'ls -la', content: 'x' },
    });
    expect(n.toolName).toBe('run_shell');
    expect(n.kind).toBe('execute');
    expect(n.command).toBe('ls -la');
    expect(n.content).toBe('x');
  });

  it('falls back path -> filePath and tolerates missing rawInput', () => {
    expect(normalizeAcp({ title: 'read', kind: 'read', rawInput: { path: '/a/b' } }).filePath).toBe('/a/b');
    const empty = normalizeAcp(undefined);
    expect(empty.toolName).toBe('');
    expect(empty.command).toBeUndefined();
  });

  it('ignores non-string rawInput values', () => {
    const n = normalizeAcp({ title: 't', rawInput: { command: 123 as unknown as string } });
    expect(n.command).toBeUndefined();
  });
});

describe('normalizeWcore', () => {
  it('maps name -> toolName, category, and args.command/file_path/content', () => {
    const n = normalizeWcore({
      name: 'run_shell',
      category: 'exec',
      args: { command: 'ls -la', file_path: '/a', content: 'y' },
    });
    expect(n.toolName).toBe('run_shell');
    expect(n.category).toBe('exec');
    expect(n.command).toBe('ls -la');
    expect(n.filePath).toBe('/a');
    expect(n.content).toBe('y');
  });

  it('tolerates missing args', () => {
    const n = normalizeWcore({ name: 'noop' });
    expect(n.toolName).toBe('noop');
    expect(n.command).toBeUndefined();
  });
});

describe('normalize parity - same destructive command denies via both backends', () => {
  it('ACP toolCall and WCore tool with the same command both -> deny', () => {
    const command = 'rm -rf /';
    const acpVerdict = evaluate(normalizeAcp({ title: 'shell', kind: 'execute', rawInput: { command } }), 'pre');
    const wcoreVerdict = evaluate(normalizeWcore({ name: 'shell', category: 'exec', args: { command } }), 'pre');
    expect(acpVerdict.action).toBe('deny');
    expect(wcoreVerdict.action).toBe('deny');
    expect(acpVerdict.ruleId).toBe(wcoreVerdict.ruleId);
  });

  it('parity for a benign command - both allow', () => {
    const command = 'git status';
    expect(evaluate(normalizeAcp({ title: 'shell', rawInput: { command } }), 'pre').action).toBe('allow');
    expect(evaluate(normalizeWcore({ name: 'shell', category: 'exec', args: { command } }), 'pre').action).toBe(
      'allow'
    );
  });
});
