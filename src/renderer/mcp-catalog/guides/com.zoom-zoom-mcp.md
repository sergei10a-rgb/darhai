---
guideVersion: 1.0.0
estimatedMinutes: 1
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: authorize
    title: Sign in with Zoom
    estSeconds: 30
    primaryAction: { label: "Sign in with Zoom", action: "oauth-flow" }
---

# Zoom setup

Zoom runs the MCP server. One sign-in and you're connected.

## Step 2 — Sign in

A browser tab opens at Zoom. Approve the scopes and you're done. Tokens are
stored in your local OS keychain.
