---
guideVersion: 1.0.0
estimatedMinutes: 4
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: bot-token
    title: Create a bot and paste its token
    estSeconds: 180
    externalAction: { label: "Open Discord Developer Portal", url: "https://discord.com/developers/applications" }
    inputs:
      - { name: DISCORD_BOT_TOKEN, label: "Bot token", secret: true }
    warning: |
      You must also invite the bot to your server with the right intents
      (Server Members, Message Content). The portal's OAuth2 URL generator
      builds an invite link for you.
---

# Discord setup

Discord MCP runs as a bot account. Free, takes a couple of minutes.

## Step 2 — Create the bot

1. Open the Discord Developer Portal and click **New Application**.
2. Under **Bot**, click **Reset Token** to reveal it, then paste it above.
3. Enable the intents you need (most setups want **Message Content Intent**).
4. Use the **OAuth2 → URL Generator** to invite the bot to your server with
   scope `bot` and the permissions you want.
