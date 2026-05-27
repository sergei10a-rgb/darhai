---
guideVersion: 1.0.0
estimatedMinutes: 7
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: azure-app
    title: Register an Azure AD application
    estSeconds: 180
    externalAction: { label: "Open Azure portal", url: "https://portal.azure.com" }
  - id: configure
    title: Configure permissions and paste IDs
    estSeconds: 180
    inputs:
      - { name: TEAMS_CLIENT_ID, label: "Application (client) ID" }
      - { name: TEAMS_TENANT_ID, label: "Directory (tenant) ID", default: "common" }
  - id: authorize
    title: Sign in with Microsoft
    estSeconds: 30
    primaryAction: { label: "Sign in with Microsoft", action: "oauth-flow" }
---

# Microsoft Teams setup

Teams talks to Microsoft Graph via an Azure AD app you register. Personal and
work accounts both work.

## Step 2 — Register an Azure AD app

1. Open the Azure portal → **Microsoft Entra ID → App registrations → New registration**.
2. Name it *Wayland Teams* (or similar).
3. **Supported account types:** *Accounts in any organizational directory and personal Microsoft accounts*.
4. **Redirect URI:** *Public client/native (mobile & desktop)* → `http://localhost:8765`.

## Step 3 — Configure permissions

1. Under **API permissions → Add a permission → Microsoft Graph → Delegated**, add:
   `Chat.ReadWrite`, `ChannelMessage.Send`, `Team.ReadBasic.All`, `OnlineMeetings.ReadWrite`, `offline_access`.
2. Copy **Application (client) ID** and **Directory (tenant) ID** into the fields above.

## Step 4 — Sign in

Click **Sign in with Microsoft** and approve.
