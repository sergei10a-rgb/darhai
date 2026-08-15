/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The local user's own records - calendar events, notes, documents and email
 * triage - together with `localUserBridge`, which answers the one question all
 * of them depend on: which `users` row this desktop runtime is acting as.
 * Each of the record tables declares a foreign key onto `users(id)`, so a
 * renderer-invented id reads back empty and fails on write; keeping the
 * identity read next to its dependents makes that coupling visible. All four
 * record bridges share the same shape too: every mutating verb is remote-denied
 * and every field is validated and clamped before it reaches its service.
 */

export * from './calendarBridge';
export * from './documentsBridge';
export * from './emailTriageBridge';
export * from './localUserBridge';
export * from './noteBridge';
