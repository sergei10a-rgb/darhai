/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges for reaching this app from somewhere that is not the local renderer:
 * the embedded web UI and the service behind it, QR pairing for a phone,
 * WeChat login, and the channel bridge that pairs and authorizes external
 * devices. `webuiDirectAuth` sits here because it is the shared gate all of
 * them lean on - the sliding-window rate limit, the native confirmation dialog
 * a renderer cannot fake, and the bcrypt check for the admin password. Keeping
 * the untrusted entry points next to their one gate is the point of the
 * grouping: a new remote surface should be unable to skip it by accident.
 *
 * `webuiQR.ts` is not re-exported directly: `webuiBridge` already forwards its
 * two public functions, and a second `export *` of the same names would make
 * them ambiguous. Import `./webuiQR` by path when the token helpers are needed
 * without the rest of the web UI surface.
 */

export * from './channelBridge';
export * from './webuiBridge';
export * from './webuiDirectAuth';
export * from './WebuiService';
export * from './weixinLoginBridge';
