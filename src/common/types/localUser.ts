/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The identity every per-user data surface (calendar / notes / documents /
 * teams / research) keys its rows on.
 *
 * There are two ways a renderer can obtain one:
 *
 *  - **WebUI / remote**: a real login against the webserver (`/api/auth/user`),
 *    which returns the authenticated account.
 *  - **Desktop**: there is no login, so the main process resolves the local
 *    profile's own row in the `users` table and hands it over the IPC bridge
 *    (`localUser.get`). It is the same row the WebUI admin account is later
 *    bootstrapped onto, so both paths converge on one identity and one dataset.
 *
 * Deliberately narrow: only what the renderer legitimately needs. No password
 * hash, no JWT secret, no e-mail.
 */
export type LocalUserIdentity = {
  /** Stable primary key in the `users` table; survives restarts. */
  id: string;
  /** Display name. Equals `id` until the WebUI admin account is named. */
  username: string;
};
