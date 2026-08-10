/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The posture badge must not leak English engineering prose into 13 locales.
 *
 * `ExecutionPolicyFrame.detail` is built in the MAIN process, which has no
 * locale, out of JSON Schema vocabulary - "critical is not true, on a field the
 * schema pins to const: true", "revision 7 skips 2 revision(s) after 4". The
 * badge used to push that string straight into the tooltip, and in the
 * `policyUnknown` state it was the tooltip's ONLY content. That is the badge's
 * worst state - no posture could be adopted for the one engine event graded
 * `critical: true` - so it was also the one place a non-English user got
 * nothing they could act on, surrounded by copy that was otherwise fully
 * localized.
 *
 * The split this file pins: the localized line is keyed off `verdict`, a closed
 * enum; the engine's own sentence is kept but labelled as a quotation. Both
 * halves are checked against the REAL locale bundles and against the union that
 * declares the verdicts, so a ninth verdict added in the main process fails
 * here instead of shipping a bare token to thirteen languages.
 */

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import type {
  CapabilityContext,
  CapabilityStreamFrame,
} from '../../../../../src/process/agent/wcore/capabilities/types';

const LOCALES_DIR = path.resolve(__dirname, '../../../../../src/renderer/services/i18n/locales');
const EXECUTION_POLICY_SRC = path.resolve(
  __dirname,
  '../../../../../src/process/agent/wcore/capabilities/handlers/executionPolicy.ts'
);
const FIXTURES = path.resolve(__dirname, '../../../../fixtures/engine-contract/desktop/v1/events');

const LOCALES = fs.readdirSync(LOCALES_DIR).filter((entry) => fs.statSync(path.join(LOCALES_DIR, entry)).isDirectory());

function agentMode(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'agentMode.json'), 'utf-8')) as Record<
    string,
    unknown
  >;
}

function verdictCopy(locale: string, verdict: string): unknown {
  const block = agentMode(locale).policyVerdict;
  return typeof block === 'object' && block !== null ? (block as Record<string, unknown>)[verdict] : undefined;
}

/**
 * The verdicts the MAIN process can actually produce, read from the union that
 * declares them.
 *
 * Hard-coding the eight names here would pass forever after a ninth was added,
 * which is the failure mode this whole file exists to prevent: the ninth would
 * render as a bare token like `throttled` in every language.
 */
function declaredVerdicts(): string[] {
  const source = fs.readFileSync(EXECUTION_POLICY_SRC, 'utf-8');
  const start = source.indexOf('export type PolicyVerdict =');
  expect(start, 'PolicyVerdict union not found - has it been renamed?').toBeGreaterThan(-1);
  const union = source.slice(start, source.indexOf(';', start));
  const found = [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  expect(found.length, 'PolicyVerdict union parsed to fewer members than it declares').toBeGreaterThanOrEqual(8);
  return found;
}

// `useWCoreMessage`, imported transitively by the send box, reaches for the IPC
// bridge at module scope. The helper under test is pure.
vi.mock('../../../../../src/common', () => ({
  ipcBridge: {
    conversation: { responseStream: { on: () => () => {} }, get: { invoke: () => Promise.resolve(null) } },
    database: { getConversationMessages: { invoke: () => Promise.resolve([]) } },
  },
}));

const { policyTooltipLines } =
  await import('../../../../../src/renderer/pages/conversation/platforms/wcore/WCoreSendBox');
const { createExecutionPolicyCapability } =
  await import('../../../../../src/process/agent/wcore/capabilities/handlers/executionPolicy');

type Frame = Parameters<typeof policyTooltipLines>[0];
type Translate = Parameters<typeof policyTooltipLines>[1];

/** A `t` that resolves against a REAL locale bundle rather than echoing keys. */
function translator(locale: string): Translate {
  const bundle = agentMode(locale);
  return ((key: string, opts?: Record<string, unknown>) => {
    const parts = key.split('.');
    expect(parts.shift(), 'the badge reached outside the agentMode namespace').toBe('agentMode');
    let node: unknown = bundle;
    for (const part of parts) {
      if (typeof node !== 'object' || node === null) {
        node = undefined;
        break;
      }
      node = (node as Record<string, unknown>)[part];
    }
    if (typeof node !== 'string') {
      return typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
    }
    let value = node;
    for (const [name, replacement] of Object.entries(opts ?? {})) {
      if (name === 'defaultValue') continue;
      value = value.replace(new RegExp(`{{${name}}}`, 'g'), String(replacement));
    }
    return value;
  }) as unknown as Translate;
}

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf-8')) as Record<string, unknown>;
}

/** Drive the real tracker so the frames under test are the engine's own. */
function lastPolicyFrame(events: Array<Record<string, unknown>>): Frame {
  const capability = createExecutionPolicyCapability();
  const frames: CapabilityStreamFrame[] = [];
  const ctx: CapabilityContext = {
    sendCommand: () => {},
    emit: (frame) => frames.push(frame),
    activeMsgId: () => '',
    log: () => {},
    warn: () => {},
  };
  for (const event of events) capability.handle(event, ctx);
  expect(frames.length).toBeGreaterThan(0);
  return frames[frames.length - 1].data as Frame;
}

describe('policy verdicts are translated in every locale', () => {
  it('finds the locale bundles to check', () => {
    // A loop over zero locales is green and worthless.
    expect(LOCALES.length).toBe(13);
  });

  it.each(LOCALES)('%s explains every verdict the main process can emit', (locale) => {
    expect(agentMode(locale).policyVerdict, `${locale}/agentMode.json has no policyVerdict block`).toBeTruthy();
    for (const verdict of declaredVerdicts()) {
      const copy = verdictCopy(locale, verdict);
      expect(typeof copy, `${locale} is missing policyVerdict.${verdict}`).toBe('string');
      expect((copy as string).trim().length, `${locale}.policyVerdict.${verdict} is blank`).toBeGreaterThan(0);
    }
  });

  it.each(LOCALES)('%s labels the engine quotation and interpolates it', (locale) => {
    const label = agentMode(locale).policyEngineDetail;
    expect(typeof label, `${locale} is missing policyEngineDetail`).toBe('string');
    // Without the placeholder the engine's own sentence would be dropped
    // entirely, which loses the only text naming the field at fault.
    expect(label as string).toContain('{{detail}}');
    // The label has to be more than the placeholder, or the quotation is
    // unattributed and reads as the app's own broken copy again.
    expect((label as string).replace('{{detail}}', '').trim().length).toBeGreaterThan(0);
  });

  it.each(LOCALES)('%s no longer prints the raw verdict token in the stale warning', (locale) => {
    // The old copy was "... ({{verdict}})", which rendered "gap" or
    // "version_mismatch" verbatim into thirteen languages.
    expect(agentMode(locale).policyStale as string).not.toContain('{{verdict}}');
  });

  it.each(LOCALES.filter((locale) => locale !== 'en-US'))('%s does not ship the English copy verbatim', (locale) => {
    for (const verdict of declaredVerdicts()) {
      expect(verdictCopy(locale, verdict), `${locale}.policyVerdict.${verdict} is still the English string`).not.toBe(
        verdictCopy('en-US', verdict)
      );
    }
  });
});

describe('the badge tooltip on real refused receipts', () => {
  it('explains the refusal in the user language, not in schema vocabulary', () => {
    // `critical` is pinned to `const: true` by the schema; a receipt claiming
    // false is refused, and with nothing adopted before it there is no posture.
    // This is the state whose entire tooltip used to be English.
    const frame = lastPolicyFrame([{ ...fixture('execution_policy'), critical: false }]);
    expect(frame.policy).toBeNull();
    expect(frame.verdict).toBe('not_critical');
    // The engine text this surface must not present as its own copy.
    expect(frame.detail).toContain('const: true');

    const mn = policyTooltipLines(frame, translator('mn-MN'));
    expect(mn[0]).toBe(verdictCopy('mn-MN', 'not_critical'));
    // The engine's sentence survives, behind a Mongolian label...
    expect(mn.join('\n')).toContain(frame.detail);
    expect(mn.join('\n')).toContain('Хөдөлгүүрийн мэдээ');
    // ...and is never the first thing the user reads.
    expect(mn[0]).not.toContain('const: true');
  });

  it('gives every locale a non-empty explanation for the unknown-posture state', () => {
    const frame = lastPolicyFrame([{ ...fixture('execution_policy'), critical: false }]);
    for (const locale of LOCALES) {
      const lines = policyTooltipLines(frame, translator(locale));
      expect(lines.length, `${locale} rendered an empty tooltip`).toBeGreaterThan(0);
      expect(lines[0].startsWith('agentMode.'), `${locale} leaked a raw i18n key`).toBe(false);
      expect(lines[0], `${locale} led with the engine's English sentence`).not.toBe(frame.detail);
    }
  });

  it('explains a refused revision gap without printing the enum token', () => {
    const first = fixture('execution_policy');
    const frame = lastPolicyFrame([first, { ...first, revision: 3 }]);
    expect(frame.stale).toBe(true);
    expect(frame.verdict).toBe('gap');

    const body = policyTooltipLines(frame, translator('ja-JP')).join('\n');
    // The localized sentence for `gap`, not the bare token.
    expect(body).toContain(verdictCopy('ja-JP', 'gap'));
    expect(body).not.toMatch(/[（(]gap[）)]/);
    // The engine's own line still carries the revision numbers an operator
    // would quote, and is still attributed.
    expect(body).toContain(frame.detail);
    expect(body).toContain('エンジンのメッセージ');
  });

  it('keeps the engine line last so the localized answer is read first', () => {
    const first = fixture('execution_policy');
    const frame = lastPolicyFrame([first, { ...first, revision: 3 }]);
    const lines = policyTooltipLines(frame, translator('en-US'));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[lines.length - 1]).toContain(frame.detail);
  });
});
