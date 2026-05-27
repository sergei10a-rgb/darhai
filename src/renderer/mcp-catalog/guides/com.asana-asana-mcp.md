---
guideVersion: 1.0.0
estimatedMinutes: 1
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: authorize
    title: Sign in with Asana
    estSeconds: 30
    primaryAction: { label: "Sign in with Asana", action: "oauth-flow" }
---

# Asana setup

Asana runs the MCP server. One click and you're connected.

## Step 2 — Sign in

A browser tab opens at Asana. Pick the workspace and approve the scopes.
Tokens are stored locally in your OS keychain.
