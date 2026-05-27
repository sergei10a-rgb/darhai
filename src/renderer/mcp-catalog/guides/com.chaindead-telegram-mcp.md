---
guideVersion: 1.0.0
estimatedMinutes: 5
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: credentials
    title: Paste api_id, api_hash, and phone number
    estSeconds: 240
    externalAction: { label: "Open my.telegram.org", url: "https://my.telegram.org" }
    inputs:
      - { name: TELEGRAM_API_ID, label: "api_id" }
      - { name: TELEGRAM_API_HASH, label: "api_hash", secret: true }
      - { name: TELEGRAM_PHONE, label: "Phone number (E.164)" }
    warning: |
      Telegram will send a login code to your account. Enter it when prompted
      in the Wayland UI on first connect. Your session file is stored locally.
---

# Telegram setup

Telegram uses *your* account (not a bot) so it works in private chats and
channels you read. About five minutes the first time.

## Step 2 — Paste credentials

1. Open **my.telegram.org** and sign in with your Telegram phone number.
2. Click **API development tools** and create an app. Name and description
   can be anything.
3. Copy `api_id` and `api_hash` and paste them above, along with your phone
   number in E.164 format (e.g. `+15555550123`).
4. On first connect, Telegram will text/in-app a login code. Wayland will
   prompt you to enter it.
