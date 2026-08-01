/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared shapes for the built-in Cal.com MCP server.
 *
 * Cal.com's API v2 is VERSIONED PER ROUTE via a mandatory `cal-api-version`
 * request header. Sending the wrong version does not return a helpful error -
 * the route simply does not resolve and the caller gets a bare Nest 404
 * ("Cannot GET /v2/event-types"). Verified live against api.cal.com on
 * 2026-08-01:
 *
 *   /v2/me            + 2024-06-14 -> 401 (route exists, key rejected)
 *   /v2/me            + 2024-08-13 -> 401
 *   /v2/bookings      + 2024-08-13 -> 401
 *   /v2/event-types   + 2024-06-14 -> 401
 *   /v2/event-types   + 2024-09-04 -> 404  <- wrong version looks like a 404
 *   /v2/schedules     + 2024-06-11 -> 401
 *   /v2/slots         + 2024-09-04 -> 200  <- public route, no key needed
 *
 * That is why {@link CAL_API_VERSIONS} exists and why every request must pick
 * its version from it rather than sharing one constant.
 */

/** Per-route `cal-api-version` values. See the module comment for the probe. */
export const CAL_API_VERSIONS = {
  me: '2024-06-14',
  bookings: '2024-08-13',
  eventTypes: '2024-06-14',
  schedules: '2024-06-11',
  slots: '2024-09-04',
} as const;

export type CalRoute = keyof typeof CAL_API_VERSIONS;

/** Default cloud base URL. Self-hosted deployments override it. */
export const CAL_DEFAULT_BASE_URL = 'https://api.cal.com/v2';

export const CAL_API_KEY_ENV = 'CALCOM_API_KEY';
export const CAL_BASE_URL_ENV = 'CALCOM_BASE_URL';

/** Cal.com wraps every answer in `{ status, data }` or `{ status, error }`. */
export type CalEnvelope<T> = {
  status?: string;
  data?: T;
  error?: { code?: string; message?: string };
};

/**
 * Thrown for every failure this server can produce. The message is always safe
 * to hand to a user or a model: {@link redactSecrets} has already run over it,
 * so an API key can never ride out inside an error string.
 */
export class CalComError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'CalComError';
    this.status = status;
  }
}

/**
 * Strip anything that looks like a Cal.com key out of arbitrary text.
 *
 * Cal.com keys are `cal_live_<hex>` / `cal_test_<hex>`. Upstream error bodies
 * have been observed to echo request context, and a bearer token must never
 * reach a model transcript or a log file, so every outbound string is filtered
 * through here before it leaves the process.
 *
 * The `live|test` alternation is load-bearing rather than cosmetic. A looser
 * `cal_[a-z]+_\w+` was tried first and mangled the server's own tool names in
 * every error message - `cal_list_bookings` came back as `cal_***redacted***` -
 * which turns a helpful failure into a confusing one. Anchoring on the two real
 * key prefixes redacts secrets without touching anything else.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/cal_(?:live|test)_[A-Za-z0-9]{6,}/g, 'cal_***redacted***')
    .replace(/(Bearer\s+)\S+/gi, '$1***redacted***');
}

/**
 * Build a redactor that also removes the literal key this process was given.
 *
 * A pattern can only guess at a key's shape; the configured value is known
 * exactly. Self-hosted deployments may issue tokens in a completely different
 * format, and this is what keeps those out of error strings too.
 */
export function makeCalRedactor(apiKey: string): (text: string) => string {
  const literal = apiKey.trim();
  if (literal.length < 8) return redactSecrets;
  return (text: string): string => redactSecrets(text.split(literal).join('***redacted***'));
}

/** One booking, normalised so the model sees a stable shape. */
export type CalBooking = {
  uid: string;
  title: string;
  status: string;
  start: string | null;
  end: string | null;
  durationMinutes: number | null;
  attendees: Array<{ name: string | null; email: string | null; timeZone: string | null }>;
  location: string | null;
  meetingUrl: string | null;
  eventTypeId: number | null;
  cancelUrl: string | null;
  rescheduleUrl: string | null;
};

/** One event type (the bookable template other people pick from). */
export type CalEventType = {
  id: number | null;
  title: string;
  slug: string;
  lengthMinutes: number | null;
  hidden: boolean;
  description: string | null;
  bookingUrl: string | null;
};
