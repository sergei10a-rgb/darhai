/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The subprocess half of the tool-confirmation gate.
 *
 * Any built-in MCP server bundled by `scripts/build-mcp-servers.js` can import
 * this one function to ask the human before it does something irreversible.
 * The IMAP server's `email_send` is the first caller; a future
 * `cal_create_booking` needs no new plumbing, only a `kind` and its own
 * details.
 *
 * FAIL CLOSED, every branch
 * -------------------------
 * The env is missing, the port is 0, the connect fails, the socket dies, the
 * main process answers with something unparseable, the reply carries no
 * outcome, `JSON` round-trips to a non-object, the app quits mid-wait: all of
 * them return `approved: false` with a reason. There is no throw to catch and
 * no undefined to coerce, so a caller cannot accidentally treat a failure as
 * consent. The only shape that means yes is `{ approved: true }`, and that can
 * only be produced by `ToolConfirmationService.respond` on a human press.
 *
 * There is deliberately NO option, argument or environment variable in this
 * module that skips the round trip. `requestUserConfirmation` has one code
 * path: build the request, send it, interpret the reply. `deps` exists only so
 * a test can substitute the transport - it cannot manufacture an approval that
 * the gate did not send.
 */

import { sendTcpRequest } from '@process/team/mcp/tcpHelpers';
import {
  denied,
  TOOL_CONFIRM_PORT_ENV,
  TOOL_CONFIRM_TIMEOUT_MS,
  TOOL_CONFIRM_TOKEN_ENV,
  type ToolConfirmationOutcome,
  type ToolConfirmationRequestInput,
} from '@process/services/toolConfirmation/types';

/**
 * Our own budget, longer than the gate's.
 *
 * The DIALOG's deadline must be the one that fires, because it produces an
 * explicit `timeout` denial the user's own window took down. If this client
 * gave up first the dialog would stay on screen with nothing listening, and a
 * later press would have nowhere to go.
 */
const REQUEST_TIMEOUT_MS = TOOL_CONFIRM_TIMEOUT_MS + 30_000;

/** Injectable transport, so a test can drive a real gate or a fake one. */
export type ConfirmationClientDeps = {
  env?: NodeJS.ProcessEnv;
  send?: (port: number, payload: unknown, timeoutMs: number) => Promise<unknown>;
};

const defaultSend = (port: number, payload: unknown, timeoutMs: number): Promise<unknown> =>
  sendTcpRequest<unknown>(port, payload, { timeoutMs });

/**
 * Ask the user to confirm one action. Resolves; never rejects.
 *
 * @returns `{ approved: true, fingerprint }` only after a human press.
 */
export async function requestUserConfirmation(
  input: ToolConfirmationRequestInput,
  deps: ConfirmationClientDeps = {}
): Promise<ToolConfirmationOutcome> {
  const env = deps.env ?? process.env;
  const port = Number.parseInt(env[TOOL_CONFIRM_PORT_ENV] ?? '0', 10);
  const token = env[TOOL_CONFIRM_TOKEN_ENV] ?? '';

  if (!Number.isInteger(port) || port <= 0 || token.length === 0) {
    return denied(
      '',
      'not-available',
      'This action needs your confirmation, but the Дархай desktop app did not provide a way to ask you ' +
        `(${TOOL_CONFIRM_PORT_ENV} / ${TOOL_CONFIRM_TOKEN_ENV} missing). Nothing was done. Restart the app and retry.`
    );
  }

  const send = deps.send ?? defaultSend;

  let reply: unknown;
  try {
    reply = await send(port, { auth_token: token, request: input }, REQUEST_TIMEOUT_MS);
  } catch (error) {
    return denied(
      '',
      'transport-error',
      `Could not reach Дархай to ask you for confirmation (${
        error instanceof Error ? error.message : String(error)
      }). Nothing was done.`
    );
  }

  return interpret(reply);
}

/**
 * Turn whatever came back into an outcome.
 *
 * Written as an allowlist rather than a cast: only a reply that is an object,
 * carries an `outcome` object, and has `approved === true` (a real boolean,
 * not a truthy string) counts as approval.
 */
function interpret(reply: unknown): ToolConfirmationOutcome {
  if (!reply || typeof reply !== 'object') {
    return denied('', 'transport-error', 'Дархай sent no answer to the confirmation, so nothing was done.');
  }

  const record = reply as { outcome?: unknown; error?: unknown };
  if (typeof record.error === 'string' && record.error.length > 0) {
    return denied(
      '',
      'transport-error',
      `Дархай refused the confirmation request (${record.error}). Nothing was done.`
    );
  }

  const outcome = record.outcome;
  if (!outcome || typeof outcome !== 'object') {
    return denied('', 'transport-error', 'Дархай sent an unreadable answer to the confirmation, so nothing was done.');
  }

  const parsed = outcome as Partial<Extract<ToolConfirmationOutcome, { approved: true }>> & {
    reason?: unknown;
    message?: unknown;
  };

  if (parsed.approved === true && typeof parsed.fingerprint === 'string' && parsed.fingerprint.length > 0) {
    return { approved: true, requestId: String(parsed.requestId ?? ''), fingerprint: parsed.fingerprint };
  }

  return denied(
    String(parsed.requestId ?? ''),
    typeof parsed.reason === 'string'
      ? (parsed.reason as Extract<ToolConfirmationOutcome, { approved: false }>['reason'])
      : 'declined',
    typeof parsed.message === 'string' ? parsed.message : 'The action was not confirmed, so nothing was done.'
  );
}
