/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The declared visual-coverage status of every route in the app.
 *
 * Visual suites rot the same way in every project: someone adds a screen,
 * nobody adds a baseline, and the suite keeps reporting green over a growing
 * blind spot. This registry makes that mechanical instead of remembered - the
 * accompanying test parses the router and fails when a route is not listed
 * here, so a new screen cannot merge without someone explicitly choosing to
 * cover it or writing down why not.
 *
 * Adding a route? Add it here with either:
 *   - `baselines: [...]` - the baseline image names that cover it, or
 *   - `skip: '<reason>'` - a real reason, not a placeholder.
 *
 * "Not covered yet" is an acceptable reason. "" is not.
 */

export type ScreenCoverage =
  /** Covered by these baseline files under `__baselines__/<platform>/`. */
  | { readonly baselines: readonly string[] }
  /** Deliberately not covered; the string must say why. */
  | { readonly skip: string };

/**
 * Route path (exactly as written in `src/renderer/components/layout/Router.tsx`)
 * → coverage status.
 */
export const SCREEN_REGISTRY: Readonly<Record<string, ScreenCoverage>> = {
  // ── Covered ───────────────────────────────────────────────────────────────
  // The first-run overlay renders over `/guid`, so its baselines are filed here.
  // Onboarding is a single overlay with several internal steps; the animated
  // in-progress scan step is deliberately absent (its log line advances every
  // 430ms, so it can never be a stable baseline).
  '/guid': {
    baselines: [
      'onboarding-quickstart.png',
      'onboarding-scan-clean-slate.png',
      'onboarding-outcome-cold.png',
      'onboarding-outcome-cli.png',
      'onboarding-interests.png',
      'onboarding-allset.png',
    ],
  },

  '/settings/models': {
    baselines: [
      'models-settings-loading.png',
      'models-settings-empty.png',
      'models-settings-error.png',
      'omniroute-card-idle.png',
      'omniroute-card-installing.png',
      'omniroute-card-starting.png',
      'omniroute-card-running.png',
      'omniroute-card-stopped.png',
      'omniroute-card-error.png',
      'omniroute-runtime-needs-runtime.png',
    ],
  },

  // ── Not routable surfaces ────────────────────────────────────────────────
  '*': { skip: 'catch-all redirect, renders no UI of its own' },
  '/settings': { skip: 'redirects to a concrete settings tab, renders no UI of its own' },
  '/test/components': { skip: 'developer-only component sandbox, not a user-facing screen' },

  // ── Auth ──────────────────────────────────────────────────────────────────
  '/login': { skip: 'not covered yet - only reachable when a password is set; needs a seeded-auth profile' },

  // ── Core surfaces (planned) ──────────────────────────────────────────────
  '/conversation/:id': { skip: 'not covered yet - needs a seeded conversation and a mocked agent' },
  '/conversations': { skip: 'not covered yet - empty and populated states both need seeding' },
  '/projects': { skip: 'not covered yet - needs seeded projects' },
  '/project/:projectId': { skip: 'not covered yet - needs a seeded project id' },
  '/memory': { skip: 'not covered yet - six IJFW status branches, each needs a stubbed status' },
  '/assistants': { skip: 'not covered yet' },
  '/notes': { skip: 'not covered yet' },
  '/calendar': { skip: 'not covered yet - renders the current month, needs the clock pinned' },
  '/documents': { skip: 'not covered yet' },
  '/research': { skip: 'not covered yet' },
  '/compare': { skip: 'not covered yet' },
  '/model-advisor': { skip: 'not covered yet - output depends on detected hardware' },
  '/mission-control': { skip: 'not covered yet - live telemetry surface' },
  '/scheduled': { skip: 'not covered yet' },
  '/scheduled/:jobId': { skip: 'not covered yet - needs a seeded job id' },
  '/workflows': { skip: 'not covered yet - library content varies with installed workflows' },
  '/wiki': { skip: 'not covered yet - ticks a live clock every 60s, needs pinning' },
  '/wiki/:slug': { skip: 'not covered yet - needs a seeded article slug' },

  // ── Teams (feature-flagged) ──────────────────────────────────────────────
  '/teams': { skip: 'not covered yet - gated behind TEAM_MODE_ENABLED' },
  '/teams/new': { skip: 'not covered yet - gated behind TEAM_MODE_ENABLED' },
  '/teams/:teamId/launch': { skip: 'not covered yet - gated behind TEAM_MODE_ENABLED' },
  '/team/:id': { skip: 'not covered yet - gated behind TEAM_MODE_ENABLED' },

  // ── Settings ─────────────────────────────────────────────────────────────
  '/settings/about': { skip: 'not covered yet - shows the version string, needs pinning' },
  '/settings/agent': { skip: 'not covered yet - legacy alias route' },
  '/settings/agents': { skip: 'not covered yet - detected agents are machine-specific, needs stubbing' },
  '/settings/assistants': { skip: 'not covered yet' },
  '/settings/capabilities': { skip: 'not covered yet' },
  '/settings/channels': { skip: 'not covered yet' },
  '/settings/channels/:id': { skip: 'not covered yet - needs a seeded channel id' },
  '/settings/constitution': { skip: 'not covered yet' },
  '/settings/display': { skip: 'not covered yet' },
  '/settings/ecc': { skip: 'not covered yet' },
  '/settings/editor': { skip: 'not covered yet' },
  '/settings/ext/:tabId': { skip: 'not covered yet - contributed by extensions, varies by install' },
  '/settings/gemini': { skip: 'not covered yet - legacy alias route' },
  '/settings/general': { skip: 'not covered yet' },
  '/settings/ijfw': { skip: 'not covered yet' },
  '/settings/images': { skip: 'not covered yet' },
  '/settings/mcp': { skip: 'not covered yet - legacy alias route' },
  '/settings/mcp-library': { skip: 'not covered yet - redirects to /browse' },
  '/settings/mcp-library/browse': { skip: 'not covered yet - catalogue content is fetched' },
  '/settings/mcp-library/installed': { skip: 'not covered yet' },
  '/settings/mcp-library/:entryId': { skip: 'not covered yet - needs a seeded entry id' },
  '/settings/model': { skip: 'not covered yet - legacy alias route' },
  '/settings/notifications': { skip: 'not covered yet' },
  '/settings/providers': { skip: 'not covered yet - legacy alias route' },
  '/settings/skills': { skip: 'not covered yet' },
  '/settings/skills-hub': { skip: 'not covered yet' },
  '/settings/storage': { skip: 'not covered yet - shows live disk usage, needs stubbing' },
  '/settings/system': { skip: 'not covered yet - shows machine info, needs stubbing' },
  '/settings/theme': { skip: 'not covered yet' },
  '/settings/tools': { skip: 'not covered yet' },
  '/settings/tools/mcp': { skip: 'not covered yet - legacy alias route' },
  '/settings/voice': { skip: 'not covered yet' },
  '/settings/wcore': { skip: 'not covered yet - legacy alias route' },
  '/settings/wcore-config': { skip: 'not covered yet' },
  '/settings/webui': { skip: 'not covered yet' },
};
