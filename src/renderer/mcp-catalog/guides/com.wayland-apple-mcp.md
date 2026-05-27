---
guideVersion: 1.0.0
estimatedMinutes: 2
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
  - id: full-disk-access
    title: Grant Full Disk Access to Wayland
    estSeconds: 60
    externalAction: { label: "Open System Settings → Privacy & Security", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" }
    primaryAction: { label: "Done — verify access", action: "verify-fda" }
---

# Apple Ecosystem setup

This MCP reads from and writes to your local macOS apps directly — no cloud, no credentials.

## Why Full Disk Access?

macOS protects Notes, Mail, and the EventKit databases (Calendar/Reminders) behind a permission gate. The Wayland app needs Full Disk Access to read and write them on your behalf. Photos uses its own permission grant, which you'll see on first use.

## Step 2 — Grant Full Disk Access

1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Toggle **Wayland** on. macOS will prompt you to authenticate.
3. Restart Wayland once.

The first time a tool touches Calendar or Reminders, EventKit may show a one-time consent dialog — approve it.
