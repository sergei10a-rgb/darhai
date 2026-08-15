/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges that speak to exactly one vendor. Each is a thin surface over that
 * vendor's own auth or capability API - Google OAuth login/logout/status, an
 * AWS Bedrock credential smoke test, a Gemini subscription probe - and none of
 * them is reachable through the generic model catalogue above. They are
 * separated so that adding a vendor never widens `model/`: a new vendor is a
 * new file here, and the routing/spend surfaces stay untouched.
 */

export * from './authBridge';
export * from './bedrockBridge';
export * from './geminiBridge';
