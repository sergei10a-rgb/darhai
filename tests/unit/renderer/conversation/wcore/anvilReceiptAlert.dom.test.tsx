/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `anvil_receipt_alert` in the transcript.
 *
 * The capability that produces this frame is the engine's tamper-evident audit
 * log. Before this surface existed the frame reached the renderer's response
 * stream and no arm read it, so a receipt the host could not vouch for was
 * decoded, graded, forwarded - and dropped on the floor one step from the user.
 * `default:` would not have saved it either: `transformMessage` has no arm for
 * this type, so the frame would have logged "unsupported message type" and
 * rendered nothing, while `setStreamRunning(true)` locked the composer for a
 * session-level fact that can arrive between turns.
 *
 * Every payload below is produced by running the REAL `anvilReceiptsCapability`
 * over the REAL vendored contract fixtures and capturing what it emitted. A
 * hand-written payload would keep passing after the projection changed shape,
 * which is precisely the class of silence this surface was added to end.
 *
 * The `t` mock resolves against the SHIPPED en-US bundle, so a key that never
 * landed in the locale resolves to its own name and the assertions fail.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  ANVIL_ALERT_FRAME,
  createAnvilReceiptsCapability,
} from '../../../../../src/process/agent/wcore/capabilities/handlers/anvilReceipts';
import type {
  AnvilAlertPayload,
  AnvilInvalidationReason,
  AnvilRejectCode,
} from '../../../../../src/process/agent/wcore/capabilities/handlers/anvilReceipts';
import type {
  CapabilityContext,
  CapabilityStreamFrame,
} from '../../../../../src/process/agent/wcore/capabilities/types';
import { adversarialFixtures, readFixture } from '../../../../helpers/engineContract';

const LOCALES_DIR = join(process.cwd(), 'src/renderer/services/i18n/locales');
const CONVERSATION = 'conv-anvil';

const streamMocks = vi.hoisted(() => ({
  handlers: [] as Array<(message: Record<string, unknown>) => void>,
  addOrUpdateMessage: vi.fn(),
}));

vi.mock('../../../../../src/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: {
        on: (handler: (message: Record<string, unknown>) => void) => {
          streamMocks.handlers.push(handler);
          return (): void => undefined;
        },
      },
      update: { invoke: vi.fn(async () => undefined) },
      get: { invoke: vi.fn(async () => ({ success: true, data: { status: 'done' } })) },
    },
  },
}));

vi.mock('../../../../../src/renderer/pages/conversation/Messages/hooks', () => ({
  useAddOrUpdateMessage: () => streamMocks.addOrUpdateMessage,
}));

vi.mock('react-i18next', async () => {
  const { readFileSync: read, existsSync: exists } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  const dir = joinPath(process.cwd(), 'src/renderer/services/i18n/locales/en-US');

  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown> & { defaultValue?: string }) => {
        const [namespace, ...path] = key.split('.');
        const file = joinPath(dir, `${namespace}.json`);
        let node: unknown = exists(file) ? JSON.parse(read(file, 'utf-8')) : undefined;
        for (const segment of path) {
          node = node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined;
        }
        let out = typeof node === 'string' ? node : (options?.defaultValue ?? key);
        for (const [name, value] of Object.entries(options ?? {})) {
          if (name === 'defaultValue') continue;
          out = out.replace(new RegExp(`{{${name}}}`, 'g'), String(value));
        }
        return out;
      },
    }),
  };
});

// `MessageTips` is rendered below to prove the two grades LOOK different. Its
// markdown branch is only reachable for JSON content, which an anvil notice
// never is, and the theme hook is a value provider - both are stubbed so the
// assertion is about the tip's own severity mapping and nothing else.
vi.mock('@renderer/components/Markdown', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light' }),
}));

const { useWCoreMessage } =
  await import('../../../../../src/renderer/pages/conversation/platforms/wcore/useWCoreMessage');
const { describeAnvilAlert, ANVIL_ALERT_MESSAGE_TYPE } =
  await import('../../../../../src/renderer/pages/conversation/platforms/wcore/anvilAlertNotice');
const { default: MessageTips } =
  await import('../../../../../src/renderer/pages/conversation/Messages/components/MessageTips');

/** The shipped en-US string for a key. Throws rather than echoing the key back. */
function en(key: string): string {
  const [namespace, ...path] = key.split('.');
  const file = join(LOCALES_DIR, 'en-US', `${namespace}.json`);
  let node: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : undefined;
  for (const segment of path) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined;
  }
  if (typeof node !== 'string') throw new Error(`en-US has no string at "${key}"`);
  return node;
}

const anvil = (name: string): Record<string, unknown>[] => readFixture(`adversarial/anvil/${name}.jsonl`);

/** Drive the real capability over real events and hand back the alerts it emitted. */
function alertsFor(events: Record<string, unknown>[]): AnvilAlertPayload[] {
  const capability = createAnvilReceiptsCapability();
  const frames: CapabilityStreamFrame[] = [];
  const ctx: CapabilityContext = {
    sendCommand: () => {},
    // A live turn id on purpose: the frame must stay session-level regardless.
    activeMsgId: () => 'turn-in-flight',
    emit: (frame) => frames.push(frame),
    log: () => {},
    warn: () => {},
  };
  for (const event of events) capability.handle(event, ctx);
  return frames.filter((frame) => frame.type === ANVIL_ALERT_FRAME).map((frame) => frame.data as AnvilAlertPayload);
}

function refusalFor(events: Record<string, unknown>[]): AnvilAlertPayload {
  const rejected = alertsFor(events).filter((alert) => alert.outcome === 'rejected');
  expect(rejected.length, 'the ledger refused nothing').toBeGreaterThan(0);
  return rejected[rejected.length - 1];
}

function retractionFor(events: Record<string, unknown>[]): AnvilAlertPayload {
  const invalidated = alertsFor(events).filter((alert) => alert.outcome === 'invalidated');
  expect(invalidated.length, 'the ledger reported no retraction').toBeGreaterThan(0);
  return invalidated[0];
}

/** The shipped receipt/retraction pair, with one field of the retraction changed. */
function retractionWith(patch: Record<string, unknown>): Record<string, unknown>[] {
  const [receipt, invalidation] = anvil('valid-invalidation');
  return [receipt, { ...invalidation, ...patch }];
}

type Tips = {
  msg_id: string;
  type: string;
  position: string;
  content: { content: string; type: 'error' | 'success' | 'warning' };
};

function deliver(payload: AnvilAlertPayload): void {
  act(() => {
    for (const handler of streamMocks.handlers) {
      // The capability's own frame name, not a copy of it: if the projection is
      // renamed and the renderer arm is not, this stops matching.
      handler({ type: ANVIL_ALERT_FRAME, data: payload, msg_id: '', conversation_id: CONVERSATION });
    }
  });
}

function notices(): Tips[] {
  return streamMocks.addOrUpdateMessage.mock.calls.map((call) => call[0] as Tips);
}

function lastNotice(): Tips {
  const all = notices();
  expect(all.length, 'the frame produced no message at all').toBeGreaterThan(0);
  return all[all.length - 1];
}

/**
 * Every reject code the capability can produce, each reached by driving the
 * real ledger, plus the grade this surface owes it.
 *
 * The split under test: `malformed`, `sequence_conflict` and `body_conflict`
 * are contradictions the host demonstrated, the rest are limits of the host.
 * Only `invalidation_unlinked` has no fixture of its own - no shipped file
 * retracts a receipt the ledger never admitted - so it is the shipped pair with
 * exactly ONE field changed, and every other byte is the engine's.
 */
const REFUSALS: Array<{
  code: AnvilRejectCode;
  severity: 'error' | 'warning';
  events: () => Record<string, unknown>[];
}> = [
  { code: 'malformed', severity: 'error', events: () => anvil('altered-body') },
  { code: 'sequence_conflict', severity: 'error', events: () => anvil('out-of-order') },
  { code: 'body_conflict', severity: 'error', events: () => anvil('duplicate-conflict') },
  { code: 'version_mismatch', severity: 'warning', events: () => anvil('version-mismatch') },
  {
    code: 'unknown_critical_extension',
    severity: 'warning',
    events: () => anvil('unknown-critical-extension'),
  },
  { code: 'sequence_gap', severity: 'warning', events: () => anvil('sequence-gap') },
  { code: 'stale_replay', severity: 'warning', events: () => anvil('stale-replay') },
  {
    code: 'invalidation_unlinked',
    severity: 'warning',
    events: () => retractionWith({ receipt_id: 'receipt-never-published' }),
  },
];

/** The three retraction reasons the schema enum allows, and their grades. */
const RETRACTIONS: Array<{ reason: AnvilInvalidationReason; severity: 'error' | 'warning' }> = [
  { reason: 'artifact_mutated', severity: 'error' },
  { reason: 'gate_revoked', severity: 'error' },
  { reason: 'superseded', severity: 'warning' },
];

beforeEach(() => {
  streamMocks.handlers.length = 0;
  streamMocks.addOrUpdateMessage.mockClear();
});
afterEach(cleanup);

describe('the renderer reads the frame the capability emits', () => {
  it('matches the capability’s own projection name, not a copy that can drift', () => {
    // The whole defect this surface fixes is a frame with no reader. Renaming
    // the projection in the main process and leaving the arm behind would
    // recreate it in silence, so the two names are pinned to each other.
    expect(ANVIL_ALERT_MESSAGE_TYPE).toBe(ANVIL_ALERT_FRAME);
  });

  it('turns a contradicted receipt into a transcript notice instead of dropping it', () => {
    const alert = refusalFor(anvil('duplicate-conflict'));
    expect(alert.code).toBe('body_conflict');

    const { result } = renderHook(() => useWCoreMessage(CONVERSATION));
    deliver(alert);

    const notice = lastNotice();
    expect(notice.type).toBe('tips');
    // Centred, like its failover and delivery neighbours: the assistant did not
    // say this, so it must not read as the assistant's own turn.
    expect(notice.position).toBe('center');
    expect(notice.content.content).toContain(en('conversation.anvilAlert.refused.body_conflict'));
    // ...and the composer is NOT put back into "generating". This frame is
    // session-level and can arrive between turns; `default:` would have locked
    // the composer with nothing running.
    expect(result.current.running).toBe(false);
  });

  it('never reuses the turn’s msg_id, so it cannot overwrite the assistant’s reply', () => {
    renderHook(() => useWCoreMessage(CONVERSATION));
    deliver(refusalFor(anvil('duplicate-conflict')));

    const notice = lastNotice();
    expect(notice.msg_id.startsWith('anvil:')).toBe(true);
    expect(notice.msg_id).not.toBe('');
    expect(notice.msg_id).not.toBe('turn-in-flight');
  });
});

describe('what the engine said, kept apart from what this host inferred', () => {
  it('quotes the engine’s receipt id, position and artifact digest verbatim', () => {
    const alert = refusalFor(anvil('duplicate-conflict'));

    renderHook(() => useWCoreMessage(CONVERSATION));
    deliver(alert);

    const content = lastNotice().content.content;
    expect(content).toContain(alert.receiptId);
    expect(content).toContain(String(alert.sequence));
    // The full digest, not a prefix: this is the value a user compares against
    // a hash of the file on disk, and a truncated one cannot be compared.
    expect(alert.artifactDigest.length).toBeGreaterThan(20);
    expect(content).toContain(alert.artifactDigest);
  });

  it('labels the host’s own diagnostic as the host’s, and never as the engine’s', () => {
    const alert = refusalFor(anvil('duplicate-conflict'));
    expect(typeof alert.detail).toBe('string');

    renderHook(() => useWCoreMessage(CONVERSATION));
    deliver(alert);

    const content = lastNotice().content.content;
    expect(content).toContain(en('conversation.anvilAlert.hostReason').replace('{{detail}}', alert.detail));
    // The label is what keeps an English host string from reading as engine
    // output; the bare detail appearing without it would be the failure.
    expect(content).not.toContain(`\n${alert.detail}`);
  });

  it('says the position is unreadable rather than printing the ledger’s -1 sentinel', () => {
    // A record with no readable `sequence` never gets a position from the
    // engine; the ledger stands in -1 so it can still report the refusal.
    const malformed = refusalFor([{ ...anvil('valid-invalidation')[0], sequence: 'not-a-number' }]);
    expect(malformed.sequence).toBe(-1);

    renderHook(() => useWCoreMessage(CONVERSATION));
    deliver(malformed);

    const content = lastNotice().content.content;
    expect(content).toContain(en('conversation.anvilAlert.noPosition'));
    expect(content).not.toContain('-1');
  });

  it('says the receipt id was not given rather than showing an empty gap', () => {
    const nameless = refusalFor([{ ...anvil('valid-invalidation')[0], receipt_id: '' }]);
    expect(nameless.receiptId).toBe('');

    renderHook(() => useWCoreMessage(CONVERSATION));
    deliver(nameless);

    expect(lastNotice().content.content).toContain(en('conversation.anvilAlert.noReceiptId'));
  });

  it('warns that a receipt binds the artifact at publication only, where that is assumed', () => {
    const retraction = retractionFor(anvil('valid-invalidation'));
    expect(retraction.reason).toBe('artifact_mutated');

    renderHook(() => useWCoreMessage(CONVERSATION));
    deliver(retraction);

    const content = lastNotice().content.content;
    // `capabilities.anvil_receipts` is graded `publication_bound`. "The artifact
    // changed" is the one sentence that invites "so Darhai is watching my
    // files", and it is not.
    expect(content).toContain(en('conversation.anvilAlert.publicationScope'));
  });

  it('does not repeat the retraction reason as an English host diagnostic', () => {
    const retraction = retractionFor(anvil('valid-invalidation'));
    // The ledger's own detail for a retraction is literally "reason <enum>",
    // which the translated headline has already said in the reader's language.
    expect(retraction.detail).toContain('artifact_mutated');

    renderHook(() => useWCoreMessage(CONVERSATION));
    deliver(retraction);

    const content = lastNotice().content.content;
    expect(content).not.toContain(en('conversation.anvilAlert.hostReason').replace('{{detail}}', ''));
    expect(content).not.toContain('reason artifact_mutated');
  });
});

describe('every verdict the capability can report gets its own reading', () => {
  it.each(REFUSALS.map((entry) => [entry.code, entry.severity] as const))(
    '%s is graded %s and carries its own sentence',
    (code, severity) => {
      const alert = refusalFor(REFUSALS.find((entry) => entry.code === code)!.events());
      expect(alert.code, `the ledger produced ${String(alert.code)} for the ${code} case`).toBe(code);

      renderHook(() => useWCoreMessage(CONVERSATION));
      deliver(alert);

      const notice = lastNotice();
      expect(notice.content.type).toBe(severity);
      expect(notice.content.content).toContain(en(`conversation.anvilAlert.refused.${code}`));
      // Nothing fell through to the catch-all sentence, which would report a
      // code the host understands as one it does not.
      expect(notice.content.content).not.toContain(
        en('conversation.anvilAlert.refused.unknown').replace('{{code}}', '')
      );
    }
  );

  it.each(RETRACTIONS.map((entry) => [entry.reason, entry.severity] as const))(
    'a %s retraction is graded %s and carries its own sentence',
    (reason, severity) => {
      const alert = retractionFor(retractionWith({ reason }));
      expect(alert.reason).toBe(reason);

      renderHook(() => useWCoreMessage(CONVERSATION));
      deliver(alert);

      const notice = lastNotice();
      expect(notice.content.type).toBe(severity);
      expect(notice.content.content).toContain(en(`conversation.anvilAlert.retracted.${reason}`));
    }
  );

  it('gives each verdict a sentence no other verdict shares', () => {
    // One sentence reused across two codes would tell the user "something is
    // wrong with the audit log" and nothing more - which is the state this
    // surface replaced.
    const headlines = [
      ...REFUSALS.map((entry) => en(`conversation.anvilAlert.refused.${entry.code}`)),
      ...RETRACTIONS.map((entry) => en(`conversation.anvilAlert.retracted.${entry.reason}`)),
    ];
    expect(new Set(headlines).size).toBe(headlines.length);
  });

  it('uses more than one grade, so the loud one still means something', () => {
    const grades = new Set([...REFUSALS, ...RETRACTIONS].map((entry) => entry.severity));
    expect(grades.size).toBeGreaterThan(1);
  });

  it('covers every reject code and retraction reason the capability declares', () => {
    // A code added to the capability's union without copy here would otherwise
    // sit untested until a user met it on a safety readout.
    const declared = readFileSync(
      join(process.cwd(), 'src/process/agent/wcore/capabilities/handlers/anvilReceipts.ts'),
      'utf-8'
    );
    const codes = /export type AnvilRejectCode =([\s\S]*?);/.exec(declared);
    expect(codes, 'AnvilRejectCode is no longer declared as a union type alias').toBeTruthy();
    const declaredCodes = [...codes![1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).toSorted();
    expect(REFUSALS.map((entry) => entry.code).toSorted()).toEqual(declaredCodes);

    const reasons = /export type AnvilInvalidationReason =(.*?);/.exec(declared);
    expect(reasons, 'AnvilInvalidationReason is no longer declared as a union type alias').toBeTruthy();
    const declaredReasons = [...reasons![1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).toSorted();
    expect(RETRACTIONS.map((entry) => entry.reason).toSorted()).toEqual(declaredReasons);
  });

  it('falls back to a translated sentence for a value it does not recognise', () => {
    // Not a hypothetical: `reason` and `code` are plain strings on the payload,
    // and a value that resolves through Object.prototype would otherwise build
    // a key no locale has and print that key at the user.
    renderHook(() => useWCoreMessage(CONVERSATION));
    deliver({ receiptId: 'r1', sequence: 0, outcome: 'rejected', code: 'toString' as AnvilRejectCode });

    const notice = lastNotice();
    expect(notice.content.content).toContain(
      en('conversation.anvilAlert.refused.unknown').replace('{{code}}', 'toString')
    );
    expect(notice.content.content).not.toContain('conversation.anvilAlert');
    // Unrecognised means "this host does not know what it is looking at", which
    // is the quieter grade by definition.
    expect(notice.content.type).toBe('warning');
  });

  it('ships every anvilAlert key in all thirteen locales', () => {
    const reference = JSON.parse(readFileSync(join(LOCALES_DIR, 'en-US', 'conversation.json'), 'utf-8')) as {
      anvilAlert: Record<string, unknown>;
    };
    const expected = Object.keys(flattenValues(reference.anvilAlert)).toSorted();
    expect(expected.length).toBeGreaterThan(0);

    for (const locale of [
      'de-DE',
      'en-US',
      'es-ES',
      'fr-FR',
      'ja-JP',
      'ko-KR',
      'mn-MN',
      'pt-BR',
      'ru-RU',
      'tr-TR',
      'uk-UA',
      'zh-CN',
      'zh-TW',
    ]) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'conversation.json'), 'utf-8')) as {
        anvilAlert?: Record<string, unknown>;
      };
      expect(bundle.anvilAlert, `${locale} has no conversation.anvilAlert block`).toBeTruthy();
      const sentences = flattenValues(bundle.anvilAlert!);
      expect(Object.keys(sentences).toSorted(), `${locale} anvilAlert keys`).toEqual(expected);
      // Mongolian must be Mongolian, not English left in place. Cyrillic in
      // every sentence is the cheapest mechanical form of that check.
      if (locale === 'mn-MN') {
        for (const sentence of Object.values(sentences)) {
          expect(/[Ѐ-ӿ]/.test(sentence), `mn-MN sentence is not Cyrillic: ${sentence}`).toBe(true);
        }
      }
    }
  });
});

/** Every string in a nested locale block, keyed by its dotted path. */
function flattenValues(node: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') out[`${prefix}${key}`] = value;
    else Object.assign(out, flattenValues(value as Record<string, unknown>, `${prefix}${key}.`));
  }
  return out;
}

describe('one line per distinct alert', () => {
  it('collapses a redelivered refusal instead of stacking the same warning twice', () => {
    // A rejected event is never recorded in the ledger's admitted slots, so an
    // at-least-once transport redelivering a batch re-runs the refusal. A
    // safety readout that repeats itself is how the one that matters gets
    // skipped, and the message list replaces in place on an msg_id hit.
    const alert = refusalFor(anvil('duplicate-conflict'));

    renderHook(() => useWCoreMessage(CONVERSATION));
    deliver(alert);
    deliver(alert);

    const keys = notices().map((notice) => notice.msg_id);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('keeps two different refusals apart even when they share a receipt and a position', () => {
    // A rejection does not advance the sequence counter, so distinct refusals
    // genuinely do share `receiptId` and `sequence`. Keying on those alone
    // would merge two facts into one line.
    const first = refusalFor(anvil('duplicate-conflict'));
    const second = refusalFor(anvil('altered-body'));
    expect(second.receiptId).toBe(first.receiptId);
    expect(second.sequence).toBe(first.sequence);
    expect(second.code).not.toBe(first.code);

    renderHook(() => useWCoreMessage(CONVERSATION));
    deliver(first);
    deliver(second);

    const keys = notices().map((notice) => notice.msg_id);
    expect(new Set(keys).size).toBe(2);
  });

  it('keeps two malformed records apart when ONLY the host’s reason differs', () => {
    // Two off-spec records that agree on receipt id, position, outcome AND
    // code: the host's diagnostic is the only field left that tells them
    // apart, so this is what forces `detail` into the key.
    const wrongOrigin = refusalFor([{ ...anvil('valid-invalidation')[0], origin: 'somewhere/else' }]);
    const wrongTerminal = refusalFor([{ ...anvil('valid-invalidation')[0], terminal_state: 'tampered' }]);
    expect(wrongOrigin.code).toBe('malformed');
    expect(wrongTerminal.code).toBe('malformed');
    expect(wrongTerminal.receiptId).toBe(wrongOrigin.receiptId);
    expect(wrongTerminal.sequence).toBe(wrongOrigin.sequence);
    expect(wrongOrigin.detail).not.toBe(wrongTerminal.detail);

    renderHook(() => useWCoreMessage(CONVERSATION));
    deliver(wrongOrigin);
    deliver(wrongTerminal);

    expect(new Set(notices().map((notice) => notice.msg_id)).size).toBe(2);
  });
});

describe('the two grades look different on screen', () => {
  function renderNotice(alert: AnvilAlertPayload): SVGElement {
    const copy = describeAnvilAlert(alert, ((key: string, options?: Record<string, unknown>) => {
      let out = en(key);
      for (const [name, value] of Object.entries(options ?? {})) {
        out = out.replace(new RegExp(`{{${name}}}`, 'g'), String(value));
      }
      return out;
    }) as never);
    const { container } = render(
      <MessageTips
        message={
          {
            id: `m-${copy.severity}`,
            type: 'tips',
            msg_id: `anvil-${copy.severity}`,
            conversation_id: CONVERSATION,
            position: 'center',
            content: { content: copy.content, type: copy.severity },
          } as never
        }
      />
    );
    const svg = container.querySelector('svg');
    expect(svg, 'the tip rendered no severity glyph at all').toBeTruthy();
    return svg!;
  }

  it('paints a proven contradiction differently from a limit of this host', () => {
    // Grading everything the same would spend the loudest colour the surface
    // has on the host's own blind spots.
    const proven = renderNotice(refusalFor(anvil('duplicate-conflict')));
    const provenStroke = proven.getAttribute('stroke');
    cleanup();
    const hostLimit = renderNotice(refusalFor(anvil('sequence-gap')));

    expect(provenStroke).toBeTruthy();
    expect(hostLimit.getAttribute('stroke')).toBeTruthy();
    expect(provenStroke).not.toBe(hostLimit.getAttribute('stroke'));
  });

  it('puts the engine’s own words on screen, not an escaped blob', () => {
    const alert = refusalFor(anvil('duplicate-conflict'));
    renderNotice(alert);
    expect(screen.getByText(new RegExp(alert.receiptId))).toBeTruthy();
  });
});

describe('the fixture corpus this surface was measured against', () => {
  it('still holds the eleven anvil fixtures these cases read', () => {
    // A new adversarial fixture should fail here rather than sit undriven while
    // the suite stays green.
    expect(adversarialFixtures('anvil')).toHaveLength(11);
  });
});
