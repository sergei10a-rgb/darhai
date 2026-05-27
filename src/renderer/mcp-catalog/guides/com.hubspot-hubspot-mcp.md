---
guideVersion: 1.0.0
estimatedMinutes: 1
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: authorize
    title: Sign in with HubSpot
    estSeconds: 30
    primaryAction: { label: "Sign in with HubSpot", action: "oauth-flow" }
---

# HubSpot setup

HubSpot runs the MCP server. Sign in once and pick which portal Wayland can
access.

## Step 2 — Sign in

A browser tab opens at HubSpot. Choose the account, approve the scopes, and
you're done.
