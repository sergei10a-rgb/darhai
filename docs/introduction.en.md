<!--
  Darhai — Introduction. A public-facing product introduction document.
  Terminology must stay in lockstep with the app's mn-MN localization
  (src/renderer/services/i18n/locales/mn-MN/). When adding a new capability,
  confirm it against the locale files first.
-->

![Darhai](../.github/assets/darhai-readme-header.png)

# Darhai — Introduction

English | [Монгол](introduction.md)

**Darhai** is a **local-first desktop AI agent app** that runs on your own computer. It drives the AI CLI tools you already use — Claude Code, Codex, Gemini, Qwen, Goose — from a single command center, turning them into **one team** with one memory and one workflow. Your keys, your files, your shell all stay on your machine.

Darhai is a fully localized, **GNU AGPL-3.0** licensed open-source project built for Mongolian users and organizations.

---

## What Darhai is

Most AI tools are a chat window pointed at a single model: every time you close it, everything is forgotten and the next session starts from zero. Darhai is something else — a **system that accumulates**:

- **It receives** your requests, files, projects, and memory state.
- **It thinks** with the model that fits the job; when needed it first writes a plan in read-only Plan mode.
- **It acts** through built-in tools (Read, Write, Edit, Bash, Grep, Glob) and MCP connectors, inside the operating system's native sandbox.
- **It remembers** across sessions through a persistent, SQLite-backed memory that carries its experience into the next task.

The installer bundles the **Darhai-Core** engine (a single Rust binary, about 47 MB — no Node or Python runtime required), so agents run the moment you add a provider key.

## Who it is for

- **Mongolian organizations** — companies, government bodies, and financial institutions that require their data to stay on their own computers and their own network. Darhai runs with no cloud broker, no subscription, and no account.
- **Developers and specialists** — people who use several tools like Claude Code, Codex, and Gemini CLI but are tired of running them one at a time.
- **Teams and users adopting AI into their work** — anyone who wants to carry out full research, writing, sales, or operations work together with AI. No programming required.

## Core capabilities

The terms below are the exact names that appear in the app's Mongolian interface.

### One agent runs everything

Run Claude Code, Codex, Gemini, Qwen, Goose, and a dozen more **CLI agents** from a single window. Switch your model mid-task from the **Model selector** menu. Anthropic, OpenAI and OpenAI-compatible (including DeepSeek, Ollama), AWS Bedrock, and Google Vertex AI providers are supported directly by the engine.

### Assistants and Teams

- **Assistants** — pre-configured AI specialists that know their domain and carry a skill set. You can build your own assistant with its own rules, prompt, and skills.
- **Teams** — AI teams with a lead and members: state your goal and they propose a lineup, then collaborate on one shared board until the work is done. Save a recurring team as a **Standing company**.

### Projects that carry work forward

A **Project** keeps its related chats, files, **knowledge base** (instructions, rules, decisions, reference files), and project memory in one place. Pick up multi-week work right where you left off.

### Skills

From the **Skill hub** you can pick from a library of 2,000+ ready-made skills, build your own, or import from a folder/Git/ZIP. Imports are security-scanned and suspicious skills are quarantined. Existing skills under `~/.claude/skills`, `~/.codex/skills`, and `~/.gemini/skills` are detected automatically.

### Memory

**Memory** keeps what you have done and decided persistent across chats, projects, and CLIs. Promote knowledge from Memory into the **Wiki**, search it, and export it. Everything is stored in SQLite on your own disk.

### Workflows and Scheduled tasks

177 ready-made **workflows** — recipes that walk you from idea to result step by step. Schedule recurring work as a **scheduled task** (daily, weekly, monthly) and receive the result in your chat. Monitor everything running from the **Control center**.

### MCP integration

Add Model Context Protocol servers over stdio, SSE, or streamable-HTTP to let your agent act on external systems like Gmail, Stripe, Slack, and Asana. Each tool's execution is governed by approve/deny control.

### Channels

Even away from your desktop, talk to your agent the way you message a colleague: connect over **channels** like Telegram, Slack, Discord, WhatsApp, Signal, Matrix, MS Teams, and LINE (25 channels total, rolling out in phases).

### Remote access (WebUI)

**Sign in with a QR code** and control everything from your phone or any browser. Deploy it on a headless server and give your team access — [WebUI guide](guides/webui.md), [server deployment](guides/deploy-server.md).

### Local operation and data privacy

- Keys are stored in the operating system keychain, data in SQLite on your disk.
- Shell commands run inside the OS-native sandbox (Landlock on Linux, sandbox-exec on macOS, AppContainer on Windows).
- Connect Ollama to run **fully offline** — with no network at all.
- There is no Darhai-hosted backend: no account, no subscription, and no cloud broker required.

## Why Mongolian first

The world's AI tools greet the Mongolian user with an English interface and English documentation. In Darhai, **Mongolian is the default**:

- The whole interface is in Mongolian — menus, settings, even error messages.
- Documentation is written in Mongolian ([User manual](guides/user-manual.md)).
- If you wish, you can switch to English from the **Language** option in Settings.

For internal use inside an organization, every employee working with AI in their native language removes the single largest barrier to adoption.

## License and name

Darhai — both the desktop app and the Darhai-Core engine — is genuine open source under **GNU AGPL-3.0**. You are free to run, self-host, modify, fork, and build commercial services on top of it; under the terms of the AGPL, a network service built on it must publish its source under the same terms.

> On the name: "Darhai" means "master smith" in Mongolian — the emblem of a craftsman who can forge and mend anything.

## Links

| What                    | Where                                              |
| ----------------------- | -------------------------------------------------- |
| Source code             | <https://github.com/sergei10a-rgb/darhai>          |
| Download (Releases)     | <https://github.com/sergei10a-rgb/darhai/releases> |
| User manual             | [guides/user-manual.md](guides/user-manual.md)     |
| Roadmap                 | [ROADMAP.md](ROADMAP.md)                           |
| Documentation structure | [README.en.md](README.en.md)                       |
| License                 | [LICENSE](../LICENSE)                              |
