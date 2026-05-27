---
guideVersion: 1.0.0
estimatedMinutes: 7
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: cloud-project
    title: Create a Google Cloud project
    estSeconds: 120
    externalAction: { label: "Open Google Cloud console", url: "https://console.cloud.google.com/projectcreate" }
  - id: oauth-client
    title: Enable APIs and create an OAuth client
    estSeconds: 180
    inputs:
      - { name: GOOGLE_OAUTH_CLIENT_ID, label: "Client ID" }
      - { name: GOOGLE_OAUTH_CLIENT_SECRET, label: "Client Secret", secret: true }
    warning: |
      Keep the OAuth app in **Testing** mode. Don't publish — Google requires
      verification (CASA) for production apps with sensitive scopes.
  - id: authorize
    title: Authorize and start the server
    estSeconds: 30
    primaryAction: { label: "Sign in with Google", action: "oauth-flow" }
---

# Google Workspace setup

The community edition keeps your data on your machine. You'll register a Google
Cloud OAuth app for personal use — it's free, takes about five minutes, and the
credentials never leave your computer.

## Step 2 — Create a Google Cloud project

A Cloud project is the container Google uses to track your OAuth app. Free, personal use is fine.

1. Open the Google Cloud console and click **New Project**.
2. Name it anything you want (e.g. *Wayland Personal*).
3. No billing required for personal Gmail/Calendar use.

## Step 3 — Enable APIs and create an OAuth client

1. Enable: Gmail API, Calendar API, Drive API, Docs API, Sheets API. (Pick only the ones you'll use.)
2. Go to **APIs & Services → OAuth consent screen**. Set user type to **External**, scope to **Testing**, and add your own Gmail address as a test user.
3. Go to **Credentials → Create credentials → OAuth client ID** and pick **Desktop app**.
4. Copy the client ID and client secret Google shows you, paste them above.
