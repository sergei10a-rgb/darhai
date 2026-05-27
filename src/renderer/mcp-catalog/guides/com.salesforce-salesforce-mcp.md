---
guideVersion: 1.0.0
estimatedMinutes: 1
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: authorize
    title: Sign in with Salesforce
    estSeconds: 30
    primaryAction: { label: "Sign in with Salesforce", action: "oauth-flow" }
---

# Salesforce setup

Salesforce runs the MCP server. Sign in to authorize Wayland on the org you
want it to access.

## Step 2 — Sign in

A browser tab opens at Salesforce. Pick the org (sandbox or production),
approve the scopes, and you're done.
