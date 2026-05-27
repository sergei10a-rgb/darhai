---
guideVersion: 1.0.0
estimatedMinutes: 2
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: api-key
    title: Paste your Attio API key
    estSeconds: 90
    externalAction: { label: "Open Attio settings → API", url: "https://app.attio.com/settings/developers" }
    inputs:
      - { name: ATTIO_API_KEY, label: "Attio API key", secret: true }
---

# Attio setup

## Step 2 — Get an API key

1. Open **Attio → Settings → Developers → API tokens**.
2. Create a token with the scopes you need (read or read+write).
3. Paste the token above.
