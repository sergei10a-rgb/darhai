/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The shapes of the MCP tool-confirmation gate.
 *
 * Why the gate exists
 * -------------------
 * An MCP server is a spawned subprocess. It has no window, no renderer and no
 * way to ask a human anything. Every tool that would do something the user
 * cannot undo - send an email, book a meeting, spend money - therefore had only
 * two options in this app: be read-only, or act on the model's word alone. The
 * Cal.com server is read-only for exactly that reason, recorded in its own
 * source: there was nowhere to put "are you sure?" that the user sees before
 * the request leaves the machine.
 *
 * This module is that missing place. A tool body asks
 * {@link ToolConfirmationRequestInput} of the main process, the main process
 * raises a dialog in the renderer, and the tool only proceeds on an explicit
 * human press. The model can propose; it cannot approve.
 *
 * Three rules are encoded in these types and must survive every future edit:
 *
 *  1. **Default deny.** {@link ToolConfirmationOutcome} is a discriminated
 *     union whose only approving member requires `approved: true` AND a
 *     `fingerprint`. Every failure - timeout, no window, app quitting, a broken
 *     socket, an unparseable reply - is expressible only as a denial. There is
 *     no "unknown" state a caller could mistake for consent.
 *  2. **Approval is bound to bytes, not to an intent.** `fingerprint` is a hash
 *     of the exact payload shown to the human. The acting code recomputes it
 *     over what it is about to do and refuses on mismatch, so an approval for
 *     "Hi mum" can never be spent on a different message.
 *  3. **One approval, one action.** `requestId` is minted per request and never
 *     reused. There is deliberately no "remember this answer", no scope, and no
 *     batch: every action costs one human press.
 *
 * This file must stay free of Electron and Node-only imports: it is bundled
 * into spawned MCP subprocesses through `builtinMcp/confirmationClient.ts`.
 */

/** Loopback TCP port of the in-process confirmation gate, injected at spawn. */
export const TOOL_CONFIRM_PORT_ENV = 'DARHAI_TOOL_CONFIRM_PORT';

/** Per-boot shared secret a bridge must present on every gate request. */
export const TOOL_CONFIRM_TOKEN_ENV = 'DARHAI_TOOL_CONFIRM_TOKEN';

/**
 * How long a dialog may wait for a human before the gate denies on its own.
 *
 * Long enough that a user who stepped away can still come back and read the
 * message properly; short enough that a forgotten dialog cannot leave a tool
 * call hanging for the rest of the session. Timing out is a DENIAL - see
 * {@link ToolConfirmationOutcome}.
 */
export const TOOL_CONFIRM_TIMEOUT_MS = 5 * 60_000;

/**
 * One labelled row of the "this is what will happen" table.
 *
 * `value` is always rendered as inert text. It routinely contains
 * model-written prose derived from an untrusted email, so it must never be
 * interpreted as markup by the dialog.
 */
export type ConfirmationDetail = {
  /** Short field name, e.g. `To`, `Subject`. Used verbatim when `labelKey` is absent. */
  label: string;
  /**
   * i18n key the renderer resolves instead of showing `label`.
   *
   * The main process has no translator - the repo's convention is to pass a
   * key and let the renderer resolve it (see `modelBridge`'s `i18nKey`). MCP
   * subprocesses send plain English field names, which is right for protocol
   * words like `To` and `Subject`; a request raised by the app itself has no
   * excuse to be untranslated, so it sends a key and `label` becomes the
   * fallback for a key that does not resolve.
   */
  labelKey?: string;
  /** The full value. NEVER truncated by the sender - the dialog scrolls. */
  value: string;
};

/**
 * A stable identifier for the KIND of action being confirmed.
 *
 * The renderer maps a known kind to fully localised chrome (title, summary,
 * confirm button). An unknown kind falls back to the plain-text `title` /
 * `summary` / `confirmLabel` the caller supplied, so a new gated tool works
 * before its translations land instead of rendering an empty dialog.
 */
export type ToolConfirmationKind = 'email.send' | (string & {});

/** What a tool body asks for. `requestId` is minted by the service, not here. */
export type ToolConfirmationRequestInput = {
  kind: ToolConfirmationKind;
  /** MCP tool name, shown verbatim so the user knows what asked. */
  toolName: string;
  /** Fallback title when `kind` has no localised chrome. */
  title: string;
  /** Fallback one-line summary when `kind` has no localised chrome. */
  summary: string;
  /** Fallback confirm-button label when `kind` has no localised chrome. */
  confirmLabel: string;
  /** Every field the human must see before deciding. Complete, never elided. */
  details: readonly ConfirmationDetail[];
  /** Hash of the exact payload these details describe. See rule 2 above. */
  fingerprint: string;
};

/**
 * What the renderer is handed: the input plus the per-request id.
 *
 * `details` is a plain array here, not a readonly one, because this value
 * crosses the IPC bridge and is structurally cloned - the caller's readonly
 * view has already been copied by the service before it reaches this shape.
 */
export type ToolConfirmationRequest = Omit<ToolConfirmationRequestInput, 'details'> & {
  requestId: string;
  details: ConfirmationDetail[];
};

/**
 * Why the gate said no.
 *
 * Every one of these is a refusal. There is no reason value that means
 * "probably fine" - that is the whole point of the union.
 */
export type ToolConfirmationDenyReason =
  'declined' | 'timeout' | 'no-window' | 'shutting-down' | 'not-available' | 'transport-error' | 'invalid-request';

export type ToolConfirmationOutcome =
  | { approved: true; requestId: string; fingerprint: string }
  | { approved: false; requestId: string; reason: ToolConfirmationDenyReason; message: string };

/** The renderer's answer. `approved` is the human's press and nothing else. */
export type ToolConfirmationResponse = { requestId: string; approved: boolean };

/** Convenience constructor so no call site hand-rolls a denial. */
export function denied(
  requestId: string,
  reason: ToolConfirmationDenyReason,
  message: string
): ToolConfirmationOutcome {
  return { approved: false, requestId, reason, message };
}

/** Human-readable sentence for a denial, safe to hand back to a model. */
export function describeDenial(outcome: ToolConfirmationOutcome): string {
  if (outcome.approved === true) return 'approved by the user';
  return `${outcome.message} (${outcome.reason})`;
}
