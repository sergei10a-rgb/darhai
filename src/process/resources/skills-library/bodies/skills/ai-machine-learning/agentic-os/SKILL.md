---
name: agentic-os
description: |
  Build a persistent, multi-agent operating system on top of an AI coding-agent runtime: a small declarative kernel that routes tasks to specialist agents, file-based memory, scheduled automation, and a JSON/markdown state layer with no external database.
  Use when building a multi-agent workflow, a "personal OS", or long-running automation that must survive session restarts.
  Do NOT use when a single prompt or one specialist agent already solves the task, or when a heavy external orchestration platform is already in place.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "ai-agents multi-agent orchestration automation memory"
  category: "ai-machine-learning"
  subcategory: "applied-ai"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# Agentic OS

Treat an AI coding-agent runtime as a persistent operating system rather than a chat session. This skill codifies the architecture used by production agentic setups: a kernel config that routes tasks to specialist agents, persistent file-based memory, scheduled automation, and a JSON/markdown data layer.

## When to Activate

- Building a multi-agent workflow inside an agent runtime
- Setting up persistent automation that survives session restarts
- Creating a "personal OS" or "agentic OS" for recurring tasks
- User says "agentic OS", "personal OS", "multi-agent", "agent coordinator", "persistent agent"
- Structuring long-running projects where context must survive across sessions

## Architecture Overview

The Agentic OS has four layers. Each layer is a directory in your project root.

```
project-root/
├── AGENTS.md          # Kernel: identity, routing rules, agent registry
├── agents/            # Specialist agent definitions (markdown prompts)
├── workflows/         # Reusable workflow definitions the host discovers
├── scripts/           # Daemon scripts: scheduled or event-driven tasks
└── data/              # State: JSON/markdown filesystem, no external DB
```

### Layer Responsibilities

| Layer | Purpose | Persistence |
|---|---|---|
| Kernel (host instructions file) | Identity, routing, model policies, agent registry | Git-tracked |
| Agents (`agents/`) | Specialist identities with scoped tools and memory | Git-tracked |
| Workflows (`workflows/`) | Named, reusable workflows (`daily-sync`, `outreach`) | Git-tracked |
| Scripts (`scripts/`) | Daemons triggered by cron or webhooks | Git-tracked |
| State (`data/`) | Append-only logs, project state, decision records | Git-ignored or tracked |

## The Kernel

The host instructions file (a project-root markdown file such as `AGENTS.md`) is the kernel. It acts as the orchestrator: the agent reads it at session start and uses it to route work.

### Kernel Structure

```markdown
# Agentic OS Kernel

## Identity
You are the orchestrator for [project-name]. You route tasks to specialist agents.
You never write code directly. You delegate to the right agent and synthesize results.

## Agent Registry

| Agent | Role | Trigger |
|---|---|---|
| @dev | Code, architecture, debugging | User says "build", "fix", "refactor" |
| @writer | Documentation, content, emails | User says "write", "draft", "blog" |
| @researcher | Research, analysis, fact-checking | User says "research", "analyze", "compare" |
| @ops | DevOps, deployment, infrastructure | User says "deploy", "CI", "server" |

## Routing Rules
1. Parse the user request for intent keywords
2. Match to the Agent Registry trigger column
3. Load the corresponding agent file from `agents/<name>.md`
4. Hand off execution with full context
5. Synthesize and present the result back to the user

## Model Policies
- Default model: use the harness default.
- @dev tasks: prefer a higher-reasoning model for complex architecture.
- @researcher tasks: use a research-capable model and approved search tools.
- Cost ceiling: warn before exceeding the project's configured spend threshold.
```

### Key Principle

The kernel should be **small and declarative**. Routing logic lives in plain markdown tables, not code. This makes the system inspectable and editable without debugging.

## Specialist Agents

Each agent is a standalone markdown file in `agents/`. The runtime loads the relevant agent file when routing a task.

### Agent Definition Format

```markdown
# @dev - Software Engineer

## Identity
You are a senior software engineer. You write clean, tested, production-grade code.
You prefer simple solutions. You ask clarifying questions when requirements are ambiguous.

## Memory Scope
- Read `data/projects/<current-project>.md` for context
- Read `data/decisions/` for architectural decisions
- Append execution logs to `data/logs/<date>-@dev.md`

## Tool Access
- Full filesystem access within project root
- Git operations (status, diff, commit, branch)
- Test runner access
- MCP servers as configured in your host's MCP configuration

## Constraints
- Always write tests for new features
- Never commit directly to `main`; use feature branches
- Prefer editing existing files over creating new ones
- Keep functions under 50 lines when possible
```

### Multi-Agent Collaboration Pattern

When a task spans multiple agents, the kernel runs them sequentially or in parallel:

```
User: "Build a landing page and write the launch blog post"

Kernel routing:
1. @dev - "Build a landing page with [requirements]"
2. @writer - "Write a launch blog post for [product] using the landing page copy"
3. Kernel synthesizes both outputs into a unified response
```

For parallel execution, use the runtime's background/subagent capability or shell scripts that invoke the agent with specific agent contexts.

## Workflows and Daily Routines

Workflows are markdown files in `workflows/`. They define reusable, named routines the host can invoke.

### Workflow Structure

```markdown
# daily-sync

Run the morning briefing:

1. Read `data/logs/last-sync.md` for context
2. Check project status: `git status`, pending PRs, CI health
3. Review `data/inbox/` for new tasks or decisions needed
4. Generate a summary of blockers, priorities, and next actions
5. Append the briefing to `data/logs/daily/<date>.md`
```

### Standard Workflow Set

| Workflow | Purpose |
|---|---|
| `daily-sync` | Morning briefing: status, blockers, priorities |
| `outreach` | Run outreach workflow (email, social, etc.) |
| `research <topic>` | Deep research with citation tracking |
| `analytics` | Pull metrics from payment, VCS, or custom sources |
| `decision <topic>` | Log a decision with pros/cons and chosen path |

### Activating Workflows

Place workflow files where your host discovers them (a `workflows/` directory or the host's equivalent). Invoke them through the host's workflow/command mechanism.

## Persistent Memory

Memory is file-based. No vector DB, no Redis, no PostgreSQL required. JSON and markdown files in `data/` are the database.

### Memory Directory Structure

```
data/
├── daily-logs/         # Append-only daily activity logs
├── projects/           # Per-project context files
├── decisions/          # Architectural and business decisions (ADR format)
├── inbox/              # New tasks or ideas awaiting triage
├── contacts/           # People, companies, relationship notes
└── templates/          # Reusable prompts and formats
```

### Daily Log Format

```markdown
# 2026-04-22 - Daily Log

## Sessions
- 09:00 - Session 1: Refactored auth module (@dev)
- 11:30 - Session 2: Drafted investor update (@writer)

## Decisions
- Switched from JWT to session cookies (see `data/decisions/2026-04-22-auth.md`)

## Blockers
- Waiting on API key from vendor (follow up 2026-04-24)

## Next Actions
- [ ] Merge auth refactor PR
- [ ] Send investor update for review
```

### Auto-Reflection Pattern

At the end of each session, the kernel appends a reflection:

```markdown
## Reflection - Session 3
- What worked: Parallel agent execution saved 20 minutes
- What didn't: @researcher hit a paywalled source, need better source ranking
- What to change: Add `source-tier` field to research notes (A/B/C credibility)
```

This creates a feedback loop that improves the system over time without code changes.

## Scheduled Automation

Agentic OS tasks run on a schedule using an external scheduler, not the runtime's in-session timer (which dies when the session ends). Replace `agent-run` below with your harness's non-interactive invocation command.

### macOS: LaunchAgent

```xml
<!-- ~/Library/LaunchAgents/com.agentic.daily-sync.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ...>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agentic.daily-sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>agent-run</string>
        <string>--cwd</string>
        <string>/path/to/project</string>
        <string>--workflow</string>
        <string>daily-sync</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>8</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/agentic-daily-sync.log</string>
</dict>
</plist>
```

### Linux: systemd Timer

```ini
# ~/.config/systemd/user/agentic-daily-sync.service
[Unit]
Description=Agentic OS Daily Sync

[Service]
Type=oneshot
ExecStart=/usr/local/bin/agent-run --cwd /path/to/project --workflow daily-sync
```

```ini
# ~/.config/systemd/user/agentic-daily-sync.timer
[Unit]
Description=Run daily sync every morning

[Timer]
OnCalendar=*-*-* 8:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

### Cross-Platform: process manager

```javascript
// ecosystem.config.js (pm2 or equivalent)
module.exports = {
  apps: [{
    name: 'agentic-daily-sync',
    script: 'agent-run',
    args: '--cwd /path/to/project --workflow daily-sync',
    cron_restart: '0 8 * * *',
    autorestart: false
  }]
};
```

## Data Layer

The data layer is your filesystem. Use JSON for structured data and markdown for narrative content.

### JSON for Structured State

```json
// data/projects/website-v2.json
{
  "name": "Website v2",
  "status": "in-progress",
  "milestone": "beta-launch",
  "agents_involved": ["@dev", "@writer"],
  "files": {
    "spec": "docs/website-v2-spec.md",
    "design": "designs/website-v2.fig"
  },
  "metrics": {
    "commits": 47,
    "last_session": "2026-04-22T11:30:00Z"
  }
}
```

### Markdown for Narrative

Use markdown for anything a human reads: decisions, logs, research notes, contact records.

### Schema Evolution

Never rename existing fields. Add new fields and mark old ones deprecated:

```json
{
  "name": "Website v2",
  "status": "in-progress",
  "milestone": "beta-launch",
  "_deprecated_priority": "high",
  "priority_v2": { "level": "high", "rationale": "Blocks investor demo" }
}
```

This keeps historical data readable without migration scripts.

## Anti-Patterns

### Monolithic Single Agent

```markdown
# BAD - One agent does everything
You are a full-stack developer, writer, researcher, and DevOps engineer.
```

Split into specialist agents. The kernel handles routing.

### Stateless Sessions

```markdown
# BAD - No memory between sessions
Starting fresh every time the runtime opens.
```

Always read `data/` at session start and write back at session end.

### Hardcoded Credentials

```markdown
# BAD - API keys in agent files or the kernel
Your API key is sk-xxxxxxxx
```

Use environment variables or a `.env` file loaded by scripts. Agents reference `process.env.API_KEY`.

### External Database for Simple State

```markdown
# BAD - PostgreSQL for a solo user's agentic OS
```

Use JSON/markdown files until you have multiple concurrent users or GBs of data.

### Over-Engineered Routing

```markdown
# BAD - Routing logic in code instead of markdown tables
if (intent.includes('deploy')) { agent = opsAgent; }
```

Keep routing declarative in the kernel markdown tables. It is inspectable, editable, and debuggable.

## Best Practices

- [ ] The kernel file is under 200 lines and fits in the context window
- [ ] Each agent file is under 100 lines and focused on one domain
- [ ] `data/` is git-ignored for sensitive logs, git-tracked for decisions and specs
- [ ] Workflows use imperative names: `daily-sync`, not `run-daily-sync`
- [ ] Logs are append-only; never edit past daily logs
- [ ] Every agent has a `Memory Scope` section defining what files it reads
- [ ] Reflections are written at the end of every session
- [ ] Scheduled tasks use an external scheduler (LaunchAgent, systemd, process manager), not the runtime's session timer
- [ ] Cost tracking: log API spend per session in `data/logs/<date>-costs.json`
- [ ] One project = one Agentic OS. Do not share a single kernel across unrelated projects.
