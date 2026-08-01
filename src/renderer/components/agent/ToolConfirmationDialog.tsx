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
 */

import { Button } from '@arco-design/web-react';
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
} as const satisfies Record<string, { title: string; summary: string; confirm: string }>;

function isKnownKind(kind: string): kind is keyof typeof KIND_KEYS {
  return Object.prototype.hasOwnProperty.call(KIND_KEYS, kind);
}

const ToolConfirmationDialog: React.FC = () => {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<IToolConfirmationRequest[]>([]);
  const [busy, setBusy] = useState(false);

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
      void ipcBridge.toolConfirmation.respond
        .invoke({ requestId, approved })
        .catch(() => {
          // The main process settles on its own timeout, and that settlement is
          // a DENIAL. Dropping the row here is safe: nothing proceeds.
        })
        .finally(() => {
          setQueue((prev) => prev.filter((q) => q.requestId !== requestId));
          setBusy(false);
        });
    },
    [setQueue]
  );

  if (!current) return null;

  const chrome = isKnownKind(current.kind) ? KIND_KEYS[current.kind] : null;
  const title = chrome ? t(chrome.title) : current.title;
  const summary = chrome ? t(chrome.summary) : current.summary;
  const confirmLabel = chrome ? t(chrome.confirm) : current.confirmLabel;

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
          <span className='text-12px text-t-tertiary'>{t('mcp.confirm.toolLabel', { tool: current.toolName })}</span>
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
                {detail.value.length > 0 ? detail.value : t('mcp.confirm.emptyValue')}
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
