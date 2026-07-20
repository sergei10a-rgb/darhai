/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { evaluate, safeEvaluate } from '@process/agent/guard/HookGuardService';
import type { GuardRule, NormalizedTool } from '@process/agent/guard/types';

const exec = (command: string): NormalizedTool => ({ toolName: 'run_shell', category: 'exec', command });
const write = (content: string): NormalizedTool => ({ toolName: 'write_file', category: 'edit', content });

describe('HookGuardService.evaluate - destructive DENY floor', () => {
  it.each([
    ['rm -rf /', 'rm -rf /'],
    ['rm -rf /*', 'rm -rf /*'],
    ['rm -rf ~', 'rm -rf ~'],
    ['rm -fr /', 'rm -fr /'],
    ['rm -r -f /', 'rm -r -f /'],
    ['rm --recursive --force --no-preserve-root /', 'rm --recursive --force --no-preserve-root /'],
    ['fork bomb', ':(){ :|:& };:'],
    ['mkfs', 'mkfs.ext4 /dev/sda1'],
    ['dd to device', 'dd if=/dev/zero of=/dev/sda bs=1M'],
    ['redirect to device', 'echo x > /dev/sda'],
    ['DROP TABLE', 'psql -c "DROP TABLE users"'],
    ['DROP DATABASE lowercase', 'mysql -e "drop database prod"'],
  ])('denies %s', (_label, command) => {
    const verdict = evaluate(exec(command), 'pre');
    expect(verdict.action).toBe('deny');
    expect(verdict.ruleId).toBeTruthy();
  });

  it('deny wins even when the config ruleset is empty (floor always applies)', () => {
    expect(evaluate(exec('rm -rf /'), 'pre', []).action).toBe('deny');
  });
});

describe('HookGuardService.evaluate - benign commands ALLOW', () => {
  it.each([
    ['ls', 'ls -la'],
    ['git status', 'git status'],
    ['npm test', 'npm test'],
    ['scoped delete', 'rm -rf ./build/node_modules'],
    ['home subdir delete', 'rm -rf ~/project/dist'],
    ['dd to null', 'dd if=/dev/zero of=/dev/null bs=1M count=10'],
    ['redirect to null', 'echo hi > /dev/null'],
    ['grep drop', 'grep DROPTABLE schema.txt'],
  ])('allows %s', (_label, command) => {
    expect(evaluate(exec(command), 'pre').action).toBe('allow');
  });
});

describe('HookGuardService.evaluate - risky WARN (never deny)', () => {
  it.each([
    ['git push --force', 'git push --force origin main'],
    ['git push -f', 'git push -f origin main'],
    ['git reset --hard', 'git reset --hard HEAD~3'],
  ])('warns on %s', (_label, command) => {
    const verdict = evaluate(exec(command), 'pre');
    expect(verdict.action).toBe('warn');
  });
});

describe('HookGuardService.evaluate - secret WARN on write content (never deny)', () => {
  it.each([
    ['openai key', 'const key = "sk-ABCDEFGHIJKLMNOPQRSTUVWX1234567890"'],
    ['aws akia', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
    ['pem private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...'],
  ])('warns (never denies) on %s', (_label, content) => {
    const verdict = evaluate(write(content), 'pre');
    expect(verdict.action).toBe('warn');
    expect(verdict.action).not.toBe('deny');
  });

  it('allows ordinary write content', () => {
    expect(evaluate(write('export const greeting = "hello world"'), 'pre').action).toBe('allow');
  });
});

describe('HookGuardService - config rules are additive', () => {
  it('applies a config deny rule on top of the built-ins', () => {
    const rules: GuardRule[] = [
      { id: 'no-curl', event: 'pre', action: 'deny', commandPattern: '\\bcurl\\b', message: 'blocked' },
    ];
    expect(evaluate(exec('curl http://x'), 'pre', rules).action).toBe('deny');
    // built-in floor still fires with the same extra ruleset present
    expect(evaluate(exec('rm -rf /'), 'pre', rules).action).toBe('deny');
  });

  it('a malformed config regex is skipped, floor still enforced', () => {
    const rules: GuardRule[] = [{ id: 'bad', event: 'pre', action: 'deny', commandPattern: '([', message: 'x' }];
    // bad rule does not throw and does not fire...
    expect(evaluate(exec('echo ok'), 'pre', rules).action).toBe('allow');
    // ...and does not disable the destructive floor
    expect(evaluate(exec('rm -rf /'), 'pre', rules).action).toBe('deny');
  });
});

describe('HookGuardService.safeEvaluate - fail-open', () => {
  it('returns allow on garbage / undefined input rather than throwing', () => {
    // Force a throw path: a frozen object whose getters throw is coerced by
    // safeEvaluate into an allow, never a crash.
    const hostile = new Proxy({} as NormalizedTool, {
      get() {
        throw new Error('boom');
      },
    });
    expect(safeEvaluate(hostile, 'pre').action).toBe('allow');
  });

  it('tolerates an empty normalized tool (all fields undefined)', () => {
    expect(safeEvaluate({ toolName: '' }, 'pre').action).toBe('allow');
  });
});
