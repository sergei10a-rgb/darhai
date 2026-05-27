---
guideVersion: 1.0.0
estimatedMinutes: 2
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: api-key
    title: Paste your Pipedrive API token + domain
    estSeconds: 90
    externalAction: { label: "Open Pipedrive personal preferences → API", url: "https://app.pipedrive.com/settings/personal/api" }
    inputs:
      - { name: PIPEDRIVE_API_TOKEN, label: "API token", secret: true }
      - { name: PIPEDRIVE_COMPANY_DOMAIN, label: "Company subdomain" }
---

# Pipedrive setup

## Step 2 — Get a token

1. Open **Pipedrive → Personal preferences → API**.
2. Copy your personal API token.
3. Paste it above, plus your company subdomain (the part before `.pipedrive.com`).
