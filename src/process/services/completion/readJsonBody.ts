/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read a completion response body that is supposed to be JSON.
 *
 * Every provider path in `oneShotComplete` used to call `res.json()` and only
 * THEN check `res.ok`. That ordering is wrong for the one case it matters: a
 * gateway in trouble answers 502/503 with an HTML error page, so parsing threw a
 * bare `SyntaxError: Unexpected token '<'` before the status could be reported.
 * The completion died with a message naming neither the provider nor the status
 * - and OmniRoute's resilience sits on top of this call, so it could not tell a
 * broken upstream from a broken request either.
 *
 * Its own module, deliberately. `oneShot.ts` pulls the provider/model/routing
 * graph, and a test that imported it just to reach this helper would pay for all
 * of that in every worker process. A pure function over a Response has no
 * business dragging that graph into a test.
 */

/** Longest slice of a non-JSON body to quote back. Enough to recognise, short enough to read. */
const BODY_SNIPPET_CHARS = 200;

/**
 * @param res - the fetch response, already awaited
 * @param label - provider/flavor name for the error message
 * @throws {Error} when the body is not JSON, naming the status and quoting a snippet
 */
export async function readJsonBody<T>(res: Response, label: string): Promise<T> {
  const raw = await res.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    const snippet = raw.slice(0, BODY_SNIPPET_CHARS).replace(/\s+/g, ' ').trim();
    throw new Error(
      `${res.status}: ${label} returned a non-JSON response${
        snippet ? ` (${snippet}${raw.length > BODY_SNIPPET_CHARS ? '…' : ''})` : ' (empty body)'
      }`
    );
  }
}
