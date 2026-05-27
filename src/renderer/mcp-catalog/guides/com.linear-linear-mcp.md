---
guideVersion: 1.0.0
estimatedMinutes: 1
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: authorize
    title: Sign in with Linear
    estSeconds: 30
    primaryAction: { label: "Sign in with Linear", action: "oauth-flow" }
---

# Linear setup

Linear runs the MCP server. One click and you're connected.

## Step 2 — Sign in

A browser tab opens at Linear. Pick the workspace you want Wayland to access,
approve the requested scopes, and you're done. Tokens are stored in your local
OS keychain.
