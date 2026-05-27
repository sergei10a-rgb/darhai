---
guideVersion: 1.0.0
estimatedMinutes: 1
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: authorize
    title: Sign in with ClickUp
    estSeconds: 30
    primaryAction: { label: "Sign in with ClickUp", action: "oauth-flow" }
---

# ClickUp setup

ClickUp runs the MCP server. Sign in once and you're connected.

## Step 2 — Sign in

A browser tab opens at ClickUp. Approve the requested scopes and select the
workspaces you want Wayland to access.
