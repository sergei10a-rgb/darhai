# darhai

Self-host **Darhai** - your always-on AI agent - on any Linux box or VPS. Headless web server, reachable from your phone.

```bash
npm install -g darhai
darhai setup     # paste a Flux key (free at fluxrouter.ai) or any OpenAI / Anthropic / Gemini key
darhai start     # then open http://<your-box-ip>:3000 - scan the QR / log in
```

First boot prints a **QR code + admin login** right in your terminal. Scan it from your phone and you're in. Set up in 60 seconds.

**Requirements:** Node 18+ and npm. On a fresh Ubuntu/Debian VPS: `sudo apt-get update && sudo apt-get install -y nodejs npm`. `darhai setup` installs everything else it needs (the bun runtime + `unzip`/`curl`).

## What `darhai setup` does

- Asks for one provider key. **Flux Router** is the easy path - one key, every model, best-fit routing (free account at [fluxrouter.ai](https://fluxrouter.ai)). It's wired as an OpenAI-compatible endpoint (`https://api.fluxrouter.ai/v1`, model `flux-auto`), so **no engine binary is required**. Bring your own OpenAI / Anthropic / Gemini key instead if you prefer.
- Stores the key as an **environment variable** in `~/.darhai-server/darhai.env` - it never touches the OS keychain (which isn't available headless).
- Ensures the **bun** runtime (offers to install it).
- Optionally installs a **systemd** service so it runs 24/7 and restarts on reboot.

## Keep it private (recommended)

Put it behind [Tailscale](https://tailscale.com) so it never touches the public internet:

```bash
tailscale serve 3000   # reachable only on your tailnet, with HTTPS
```

Otherwise it binds `0.0.0.0` - front it with a reverse proxy + TLS, and rely on the built-in login + rate limiting.

## Commands

|                |                                           |
| -------------- | ----------------------------------------- |
| `darhai setup` | Paste a key, wire it, get your login      |
| `darhai start` | Run the server (reads the env from setup) |
| `darhai help`  | Usage                                     |

Override the data dir with `DATA_DIR=…`, the port with `PORT=…`.

## Notes

- The **Wayland Core** engine (`aionrs`) is fetched per-platform on install (Linux/macOS x64+arm64). If the download is skipped, the Flux / API-key path still works - only the Wayland Core agent is unavailable until the engine is present.
- Adding a _new_ key from the web UI on a headless box is a known fast-follow (in-app key storage needs a headless secret backend); for now, add keys by re-running `darhai setup`.

AGPL-3.0-or-later · [sergei10a-rgb/darhai](https://github.com/sergei10a-rgb/darhai)
