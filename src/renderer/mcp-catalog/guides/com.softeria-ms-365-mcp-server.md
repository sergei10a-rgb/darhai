---
guideVersion: 1.0.0
estimatedMinutes: 8
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: azure-app
    title: Register an Azure AD application
    estSeconds: 180
    externalAction: { label: "Open Azure portal", url: "https://portal.azure.com" }
  - id: configure-permissions
    title: Configure permissions and paste IDs
    estSeconds: 180
    inputs:
      - { name: MS365_CLIENT_ID, label: "Application (client) ID" }
      - { name: MS365_TENANT_ID, label: "Directory (tenant) ID", default: "common" }
      - { name: MS365_CLIENT_SECRET, label: "Client secret (optional)", secret: true }
    warning: |
      Use **common** as the tenant for personal Microsoft accounts. For work
      accounts, use your organization's tenant ID.
  - id: authorize
    title: Sign in with Microsoft
    estSeconds: 30
    primaryAction: { label: "Sign in with Microsoft", action: "oauth-flow" }
---

# Microsoft 365 setup

The Softeria community MCP talks to Microsoft Graph using an Azure AD app you
own. Free for personal accounts. Five-ish minutes.

## Step 2 — Register an Azure AD app

1. Open the Azure portal and navigate to **Microsoft Entra ID → App registrations → New registration**.
2. Name it *Wayland Personal* (or anything memorable).
3. **Supported account types:** *Accounts in any organizational directory and personal Microsoft accounts*.
4. **Redirect URI:** *Public client/native (mobile & desktop)* → `http://localhost:8765`.
5. Click **Register**.

## Step 3 — Configure permissions and paste IDs

1. Under **API permissions → Add a permission → Microsoft Graph → Delegated**, add:
   `Mail.ReadWrite`, `Calendars.ReadWrite`, `Files.ReadWrite`, `Chat.ReadWrite`,
   `Tasks.ReadWrite`, `Notes.ReadWrite`, `offline_access`.
2. Click **Grant admin consent** if available (personal accounts skip this).
3. On the app overview page, copy **Application (client) ID** and **Directory (tenant) ID** into the fields above.
4. (Optional) Under **Certificates & secrets**, create a client secret if you want background refresh.
