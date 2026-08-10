/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The dialog an MCP tool raises when it needs a human to say yes.
 *
 * Mounted once, globally, from `Layout`. A gated tool (today `email_send`,
 * tomorrow a Cal.com booking) reaches the main process over loopback, the main
 * process pushes `toolConfirmation.request` here, and NOTHING happens until the
 * person presses the confirm button.
 *
 * Four rules this component exists to enforce:
 *
 *  1. **Everything is inert text.** `detail.value` is routinely model-written
 *     prose derived from an email a stranger sent. It is rendered into a text
 *     node inside a `<pre>` - never `dangerouslySetInnerHTML`, never Markdown,
 *     never a link. A body containing `<script>alert(1)</script>` or
 *     `[APPROVED]` shows up as those literal characters, so it cannot disguise
 *     what is being approved or forge the app's own chrome.
 *  2. **Nothing is truncated.** The user must see the WHOLE message they are
 *     about to send. Long values scroll; they are never elided, because the
 *     dangerous sentence is exactly the one a summary would drop.
 *  3. **Closing is refusing.** Escape, the X, the mask and Cancel all answer
 *     `approved: false`. There is no way to dismiss this dialog that leaves the
 *     action to happen anyway.
 *  4. **One press, one action.** Requests queue and are answered one at a time.
 *     There is no "approve all" and no memory of a previous answer.
 *  5. **Nothing is asserted that was not received.** A detail the sender left
 *     empty - including one that is only whitespace - is shown as such, never
 *     as `0` or an invented default, and a request that arrives with no details
 *     at all says so instead of rendering a blank body above a confirm button.
 *
 * The same dialog carries the engine's own questions: `agent.toolApproval`
 * (a paused turn asking permission) and `agent.budgetGrant` (a budget cap that
 * ended the turn, where pressing confirm sends `continue_with_budget`). Money
 * and tools go through one gate with one set of rules rather than two.
 */

import { Alert, Button } from '@arco-design/web-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { IToolConfirmationRequest } from '@/common/adapter/ipcBridge';
import DarhaiModal from '@/renderer/components/base/DarhaiModal';

/**
 * Localised chrome for the kinds we ship.
 *
 * A `kind` that is not listed falls back to the plain strings the requesting
 * tool supplied, so a newly gated tool shows a correct - if untranslated -
 * dialog instead of an empty one. Adding a kind here plus its 13 locale
 * strings is the whole cost of gating the next tool.
 */
const KIND_KEYS = {
  'email.send': {
    title: 'mcp.confirm.emailSend.title',
    summary: 'mcp.confirm.emailSend.summary',
    confirm: 'mcp.confirm.emailSend.confirm',
  },
  // The engine pausing a turn to ask permission. Same dialog, same rules - the
  // request comes from the local engine rather than an MCP subprocess, which
  // changes nothing about who is allowed to answer it.
  'agent.toolApproval': {
    title: 'mcp.confirm.agentTool.title',
    summary: 'mcp.confirm.agentTool.summary',
    confirm: 'mcp.confirm.agentTool.confirm',
  },
  // A budget cap ended the turn and the engine publishes a way back
  // (`continue_with_budget`). Granting it is spending money, which is exactly
  // the class of decision this dialog exists for, so the grant rides the same
  // default-deny gate rather than a new one - closing still refuses, and one
  // press still answers exactly one request.
  'agent.budgetGrant': {
    title: 'mcp.confirm.budgetGrant.title',
    summary: 'mcp.confirm.budgetGrant.summary',
    confirm: 'mcp.confirm.budgetGrant.confirm',
    // A figure this dialog did not receive must read as UNKNOWN, not as the
    // neutral "(empty)" the other kinds use and never as 0: on a spend
    // decision a missing number is a reason to hesitate, not a blank field.
    unknownValue: 'mcp.confirm.budgetGrant.unknown',
    // No tool asked for this one - a budget cap did - so the footer must not
    // read "Requested by budget". On a dialog whose stated purpose is "so the
    // user knows what asked", that line has to answer the question.
    footer: 'mcp.confirm.budgetGrant.footer',
  },
} as const satisfies Record<
  string,
  { title: string; summary: string; confirm: string; unknownValue?: string; footer?: string }
>;

function isKnownKind(kind: string): kind is keyof typeof KIND_KEYS {
  return Object.prototype.hasOwnProperty.call(KIND_KEYS, kind);
}

/**
 * Why a press can fail to land, in the words the user needs.
 *
 * `expired` - the main process no longer held the request (it timed out, or
 * the window went away), so it has already been answered as a DENIAL.
 * `undelivered` - the answer never reached the main process at all.
 *
 * Both mean the same thing for the user's money: nothing was granted. They are
 * kept apart because only one of them is worth pressing again.
 */
type AnswerFailure = 'expired' | 'undelivered';

const ToolConfirmationDialog: React.FC = () => {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<IToolConfirmationRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AnswerFailure | null>(null);

  const current = queue[0] ?? null;

  useEffect(() => {
    // A renderer reload leaves the main process holding dialogs whose windows
    // are gone. Re-draw them rather than stranding the tool that is waiting.
    void ipcBridge.toolConfirmation.listPending
      .invoke()
      .then((pending) => {
        if (Array.isArray(pending) && pending.length > 0) {
          setQueue((prev) => [...prev, ...pending.filter((p) => !prev.some((q) => q.requestId === p.requestId))]);
        }
      })
      .catch(() => {
        // Nothing to restore is the normal case; a failure here must not break
        // the live listeners below.
      });

    const offRequest = ipcBridge.toolConfirmation.request.on((request) => {
      setQueue((prev) => (prev.some((q) => q.requestId === request.requestId) ? prev : [...prev, request]));
    });
    const offCancel = ipcBridge.toolConfirmation.cancel.on(({ requestId }) => {
      setQueue((prev) => prev.filter((q) => q.requestId !== requestId));
    });
    return () => {
      offRequest?.();
      offCancel?.();
    };
  }, []);

  const answer = useCallback(
    (requestId: string, approved: boolean) => {
      setBusy(true);
      setFailure(null);
      const drop = (): void => setQueue((prev) => prev.filter((q) => q.requestId !== requestId));

      void ipcBridge.toolConfirmation.respond
        .invoke({ requestId, approved })
        .then((result) => {
          // `settled: false` is the service telling us it no longer held this
          // request - it had already timed out, i.e. been DENIED. Saying so
          // matters for an approval: the user pressed a button that spends
          // money and it did not take effect.
          if (approved && result?.settled === false) {
            setFailure('expired');
            return;
          }
          drop();
        })
        .catch(() => {
          // A refusal that never arrived is still a refusal - the main process
          // settles its own timeout as a DENIAL - so dropping the row states
          // the true outcome: nothing was done. An APPROVAL that never arrived
          // is the opposite: the user believes they granted something. Keep it
          // on screen and say otherwise. (If the gate has meanwhile cancelled
          // the request, its own event takes the row down and the decision is
          // over regardless.)
          if (!approved) {
            drop();
            return;
          }
          setFailure('undelivered');
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [setQueue]
  );

  // A failure belongs to the request that was on screen when it happened;
  // carrying it onto the next one would accuse a dialog that never failed.
  useEffect(() => {
    setFailure(null);
  }, [current?.requestId]);

  if (!current) return null;

  const chrome = isKnownKind(current.kind) ? KIND_KEYS[current.kind] : null;
  const title = chrome ? t(chrome.title) : current.title;
  const summary = chrome ? t(chrome.summary) : current.summary;
  const confirmLabel = chrome ? t(chrome.confirm) : current.confirmLabel;
  // `in` rather than an optional read: KIND_KEYS is a union of literal shapes,
  // and only some members carry an override.
  const missingValue = chrome && 'unknownValue' in chrome ? t(chrome.unknownValue) : t('mcp.confirm.emptyValue');
  const requestedBy =
    chrome && 'footer' in chrome ? t(chrome.footer) : t('mcp.confirm.toolLabel', { tool: current.toolName });
  // `expired` means the gate no longer held this request - it had already timed
  // out, i.e. been DENIED, and it settles exactly once. Pressing the primary
  // button again can only reproduce the same terminal error, so the button that
  // cannot work stops looking like the way out; Cancel closes the row.
  const settledElsewhere = failure === 'expired';

  return (
    <DarhaiModal
      visible
      size='large'
      maskClosable={false}
      escToExit
      header={{ title, showClose: true }}
      onCancel={() => !busy && answer(current.requestId, false)}
      contentStyle={{ padding: 0, maxHeight: '60vh', overflow: 'auto' }}
      footer={
        <div className='flex items-center justify-between gap-12px w-full'>
          <span className='text-12px text-t-tertiary'>{requestedBy}</span>
          <div className='flex gap-12px'>
            <Button
              disabled={busy}
              onClick={() => answer(current.requestId, false)}
              className='px-16px min-w-80px'
              style={{ borderRadius: 8 }}
            >
              {t('mcp.confirm.cancel')}
            </Button>
            <Button
              type='primary'
              loading={busy}
              disabled={settledElsewhere}
              onClick={() => answer(current.requestId, true)}
              className='min-w-96px'
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      }
    >
      <div className='flex flex-col gap-16px py-8px'>
        <p className='text-14px text-t-primary m-0'>{summary}</p>

        <p className='text-12px text-t-tertiary m-0'>{t('mcp.confirm.untrustedNotice')}</p>

        {failure && (
          <Alert
            type='error'
            content={t(failure === 'expired' ? 'mcp.confirm.answerExpired' : 'mcp.confirm.answerUndelivered')}
          />
        )}

        {/*
          A request whose details did not arrive is not a dialog with a blank
          middle: it is a decision the user has no basis for. Say that, and let
          them refuse, rather than showing an empty box above an Allow button.
        */}
        {current.details.length === 0 && <p className='text-13px text-t-primary m-0'>{t('mcp.confirm.noDetails')}</p>}

        <dl className='flex flex-col gap-12px m-0'>
          {current.details.map((detail, index) => (
            <div key={`${detail.label}-${index}`} className='flex flex-col gap-4px'>
              {/*
                A request raised by the app itself sends `labelKey` so the field
                name is translated; an MCP subprocess sends a plain English name
                like `To`, which is correct for a protocol word and is used
                as-is. `label` is also the fallback when a key does not resolve.
              */}
              <dt className='text-12px font-500 text-t-secondary'>
                {detail.labelKey ? t(detail.labelKey as never, { defaultValue: detail.label }) : detail.label}
              </dt>
              {/* Text node only. Never markup - see rule 1 in the module comment. */}
              <dd
                className='m-0 text-13px text-t-primary whitespace-pre-wrap break-words rd-8px bg-2 px-12px py-8px max-h-240px overflow-auto'
                style={{ fontFamily: 'inherit' }}
              >
                {/*
                  `.trim()`, not `.length`: a value of " " or a lone TAB has
                  length > 0 and would skip the unknown/empty override, painting
                  a silently blank box inside a `whitespace-pre-wrap` cell - the
                  blank field on a spend dialog that rule 5 exists to prevent.
                  Not hypothetical here: the engine contract ships an adversarial
                  budget fixture whose request_id is a raw TAB, so whitespace-only
                  engine strings are a known shape in this exact subsystem.
                */}
                {detail.value.trim().length > 0 ? detail.value : missingValue}
              </dd>
            </div>
          ))}
        </dl>

        {queue.length > 1 && (
          <p className='text-12px text-t-tertiary m-0'>{t('mcp.confirm.queued', { count: queue.length - 1 })}</p>
        )}
      </div>
    </DarhaiModal>
  );
};

ToolConfirmationDialog.displayName = 'ToolConfirmationDialog';

export default ToolConfirmationDialog;
