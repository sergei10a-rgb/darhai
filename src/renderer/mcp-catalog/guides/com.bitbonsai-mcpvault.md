---
guideVersion: 1.0.0
estimatedMinutes: 1
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: vault-path
    title: Point Wayland at your vault folder
    estSeconds: 30
    inputs:
      - { name: OBSIDIAN_VAULT_PATH, label: "Absolute path to your vault" }
---

# Obsidian Vault setup

mcpvault reads your vault as plain Markdown — no Obsidian plugin or running
app required.

## Step 2 — Point at your vault

1. In Obsidian, right-click your vault → **Reveal vault folder**.
2. Copy the full path.
3. Paste it above (e.g. `/Users/you/Documents/Vault`).

The server only reads inside the path you supply.
