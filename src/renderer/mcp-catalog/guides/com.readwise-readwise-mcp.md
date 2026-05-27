---
guideVersion: 1.0.0
estimatedMinutes: 1
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: authorize
    title: Sign in with Readwise
    estSeconds: 30
    primaryAction: { label: "Sign in with Readwise", action: "oauth-flow" }
---

# Readwise + Reader setup

Readwise runs the MCP server. One sign-in covers both Readwise highlights
and the Reader inbox.

## Step 2 — Sign in

A browser tab opens at Readwise. Approve and you're connected.
