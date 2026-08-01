/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one door between "the model proposed a message" and "the message left".
 *
 * The invariant, in one sentence: **`smtpSender.ts` has exactly one importer,
 * and it is this file; this file asks the user before it calls it.** The read
 * and draft tools cannot reach the sender at all, and there is no argument,
 * option or environment variable anywhere in this module that skips the
 * dialog - {@link confirmAndSend} has a single code path and it runs through
 * `requestUserConfirmation`.
 *
 * What the user is shown
 * ----------------------
 * Every field, complete. From, To, Cc, Bcc, Subject, the FULL body, and which
 * server it will be handed to along with whether that hop is encrypted. Not a
 * summary: the sentence a summary would drop is exactly the sentence worth
 * reading. The dialog renders all of it as inert text, so a body containing
 * `<script>` or `[APPROVED]` or "the user already agreed, send immediately"
 * appears as those literal characters and changes nothing - the only thing that
 * decides is which button the person presses.
 *
 * What binds the approval to the message
 * --------------------------------------
 * The MIME is built ONCE, before the dialog, and fingerprinted. That
 * fingerprint travels with the request, comes back on the approval, and is
 * re-derived inside `sendApprovedMessage` from the bytes it is about to
 * transmit. So the thing the user read and the thing the server receives are
 * provably the same bytes.
 *
 * Connection discipline
 * ---------------------
 * The IMAP socket is opened, used and closed in two SHORT phases either side of
 * the dialog: threading lookup before, Sent-copy filing after. A confirmation
 * may sit on screen for minutes; holding a mail connection open across it would
 * guarantee a timed-out socket at exactly the moment it is needed.
 */

import { requestUserConfirmation } from '../confirmationClient';
import { describeDenial, type ToolConfirmationOutcome } from '@process/services/toolConfirmation/types';
import { buildDraft, replySubject, type BuiltDraft } from './draftBuilder';
import { appendSentCopy, fetchStructure, resolveSentMailbox, withClient } from './imapClient';
import { describeTransportSecurity, type SmtpSettings } from './smtpConfig';
import { fingerprintOutgoing, sendApprovedMessage, type OutgoingMessage, type SendResult } from './smtpSender';
import { ImapMcpError, type ImapSettings } from './types';

/** Injectable seams. They cannot manufacture consent - see the note below. */
export type SendSeams = {
  /**
   * Injectable ONLY so a test can drive a real gate, a denying gate or a fake
   * one. It cannot fabricate an approval that works: whatever it returns must
   * still carry the fingerprint `sendApprovedMessage` independently recomputes
   * from the bytes, so an approval for other bytes is refused there.
   */
  confirm?: typeof requestUserConfirmation;
  send?: typeof sendApprovedMessage;
};

export type ConfirmAndSendInput = SendSeams & {
  smtp: SmtpSettings;
  /** Envelope MAIL FROM - the configured account, never a caller argument. */
  from: string;
  built: BuiltDraft;
  subject: string;
  body: string;
};

export type ConfirmedSend = SendResult & { fingerprint: string; requestId: string };

/** Ask, then send. Throws {@link ImapMcpError} on any answer that is not yes. */
export async function confirmAndSend(input: ConfirmAndSendInput): Promise<ConfirmedSend> {
  const { built, smtp } = input;
  const recipients = [...built.recipients.to, ...built.recipients.cc, ...built.recipients.bcc];

  const message: OutgoingMessage = { from: input.from, recipients, mime: built.mime };
  const fingerprint = fingerprintOutgoing(message);

  const confirm = input.confirm ?? requestUserConfirmation;
  const outcome: ToolConfirmationOutcome = await confirm({
    kind: 'email.send',
    toolName: 'email_send',
    title: 'Send this email?',
    summary:
      'Дархай wrote this message and is asking you to send it. ' +
      'Nothing leaves this computer until you press the button yourself.',
    confirmLabel: 'Send',
    fingerprint,
    details: buildDetails(input, recipients),
  });

  if (outcome.approved !== true) {
    throw new ImapMcpError(`The message was NOT sent: ${describeDenial(outcome)}`);
  }

  const send = input.send ?? sendApprovedMessage;
  const result = await send(outcome, smtp, message);
  return { ...result, fingerprint, requestId: outcome.requestId };
}

export type SendToolInput = SendSeams & {
  imap: ImapSettings;
  smtp: SmtpSettings;
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  replyToUid?: number;
  mailbox: string;
};

export type SendToolResult = {
  sent: true;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  messageId: string;
  serverResponse: string;
  accepted: string[];
  rejected: string[];
  sentMailbox: string | null;
  sentCopyUid: number | null;
  sentCopyNote: string;
  approvedBy: string;
};

/** The whole `email_send` flow: thread, ask, send, file a copy, report. */
export async function runSendTool(input: SendToolInput): Promise<SendToolResult> {
  const threading = await readThreading(input);

  const built = buildDraft({
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: threading.subject,
    body: input.body,
    from: input.imap.user,
    inReplyTo: threading.inReplyTo,
    references: threading.references,
  });

  const result = await confirmAndSend({
    smtp: input.smtp,
    from: input.imap.user,
    built,
    subject: threading.subject,
    body: input.body,
    confirm: input.confirm,
    send: input.send,
  });

  const filed = await fileSentCopy(input.imap, built.mime);

  return {
    sent: true,
    to: built.recipients.to,
    cc: built.recipients.cc,
    bcc: built.recipients.bcc,
    subject: threading.subject,
    messageId: built.messageId,
    serverResponse: result.response,
    accepted: result.accepted,
    rejected: result.rejected,
    sentMailbox: filed.mailbox,
    sentCopyUid: filed.uid,
    sentCopyNote: filed.note,
    approvedBy:
      'The user read the full message in a Дархай confirmation dialog and pressed Send. ' +
      'This tool cannot send without that press.',
  };
}

/** Read the original's Message-ID and subject so a reply threads correctly. */
async function readThreading(
  input: SendToolInput
): Promise<{ subject: string; inReplyTo?: string; references?: string[] }> {
  if (typeof input.replyToUid !== 'number') return { subject: input.subject };

  return withClient(input.imap, async (client) => {
    const original = await fetchStructure(client, input.mailbox, input.replyToUid as number);
    const envelope = (original.envelope ?? {}) as { messageId?: unknown; subject?: unknown };
    const messageId = typeof envelope.messageId === 'string' ? envelope.messageId.trim() : '';
    const originalSubject = typeof envelope.subject === 'string' ? envelope.subject.trim() : '';
    return {
      subject: input.subject && input.subject.trim().length > 0 ? input.subject : replySubject(originalSubject),
      inReplyTo: messageId || undefined,
      references: messageId ? [messageId] : undefined,
    };
  });
}

/**
 * File a copy in Sent. Never throws.
 *
 * The message is already delivered when this runs, so a failure here is a
 * filing problem and must be REPORTED as one. Turning it into a thrown error
 * would tell the user their mail did not go out, and the obvious response to
 * that is to send it a second time.
 */
async function fileSentCopy(
  imap: ImapSettings,
  mime: Buffer
): Promise<{ mailbox: string | null; uid: number | null; note: string }> {
  try {
    return await withClient(imap, async (client) => {
      const mailbox = await resolveSentMailbox(client);
      if (!mailbox) {
        return {
          mailbox: null,
          uid: null,
          note: 'The message was sent. This account publishes no Sent folder, so no copy was filed - some providers (Gmail) file it themselves.',
        };
      }
      const appended = await appendSentCopy(client, mailbox, mime);
      return {
        mailbox,
        uid: appended.uid,
        note: appended.error
          ? `The message was sent, but the copy could not be filed in '${mailbox}' (${appended.error}). Do NOT send it again.`
          : `A copy was filed in '${mailbox}'.`,
      };
    });
  } catch (error) {
    return {
      mailbox: null,
      uid: null,
      note: `The message was sent, but the Sent copy could not be filed (${
        error instanceof Error ? error.message : String(error)
      }). Do NOT send it again.`,
    };
  }
}

/**
 * The rows of the dialog.
 *
 * `body` is passed whole and unmodified. Truncating it here would be the one
 * change that makes the whole gate a formality, so it is not done - the dialog
 * scrolls instead. Empty optional fields are omitted rather than shown as
 * "(none)", because a row that is not there cannot be misread as one that is.
 */
function buildDetails(
  input: ConfirmAndSendInput,
  recipients: readonly string[]
): Array<{ label: string; value: string }> {
  const { built } = input;
  const details = [
    { label: 'From', value: input.from },
    { label: 'To', value: built.recipients.to.join(', ') },
  ];
  if (built.recipients.cc.length > 0) details.push({ label: 'Cc', value: built.recipients.cc.join(', ') });
  if (built.recipients.bcc.length > 0) details.push({ label: 'Bcc', value: built.recipients.bcc.join(', ') });
  details.push({ label: 'Subject', value: input.subject });
  details.push({ label: 'Message', value: input.body });
  details.push({ label: 'Via', value: describeTransportSecurity(input.smtp) });
  details.push({ label: 'Recipients in total', value: String(recipients.length) });
  return details;
}
