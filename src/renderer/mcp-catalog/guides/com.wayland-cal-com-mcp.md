---
guideVersion: 1.0.0
estimatedMinutes: 2
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: api-key
    title: Paste your Cal.com API key
    estSeconds: 90
    externalAction: { label: "Open Cal.com API keys", url: "https://app.cal.com/settings/developer/api-keys" }
    inputs:
      - { name: CALCOM_API_KEY, label: "Cal.com API key", secret: true }
      - { name: CALCOM_BASE_URL, label: "Base URL (self-hosted only)", default: "https://api.cal.com/v2" }
---

# Cal.com Scheduling setup

Cal.com is open-source and self-hostable. The MCP works against the hosted
cal.com service by default; point `CALCOM_BASE_URL` at your own instance for
self-hosted setups.

## Step 2 — Get an API key

1. Open Cal.com → **Settings → Developer → API keys**.
2. Click **Add** and copy the key.
3. Paste it above.
