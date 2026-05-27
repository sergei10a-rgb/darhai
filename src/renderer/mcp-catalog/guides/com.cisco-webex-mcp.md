---
guideVersion: 1.0.0
estimatedMinutes: 2
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: token
    title: Paste your Webex access token
    estSeconds: 90
    externalAction: { label: "Open Webex Developer portal", url: "https://developer.webex.com" }
    inputs:
      - { name: WEBEX_ACCESS_TOKEN, label: "Webex personal access token", secret: true }
    warning: |
      Personal access tokens expire after 12 hours. For long-term use, register
      a Webex integration and supply an OAuth refresh token instead.
---

# Webex setup

## Step 2 — Get a token

1. Sign in at **developer.webex.com**.
2. Your **Personal Access Token** is at the top of the page (click to copy).
3. Paste it above. Wayland uses it until it expires; for permanent access,
   register an integration in the Webex App Hub.
