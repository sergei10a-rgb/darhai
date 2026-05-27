---
guideVersion: 1.0.0
estimatedMinutes: 1
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: authorize
    title: Sign in with Atlassian
    estSeconds: 30
    primaryAction: { label: "Sign in with Atlassian", action: "oauth-flow" }
---

# Atlassian setup

Atlassian runs the MCP server for both Jira and Confluence. One sign-in gives
access to both products on the cloud sites you choose.

## Step 2 — Sign in

A browser tab opens at id.atlassian.com. Pick the site (e.g. *acme.atlassian.net*),
approve the scopes, and you're done.
