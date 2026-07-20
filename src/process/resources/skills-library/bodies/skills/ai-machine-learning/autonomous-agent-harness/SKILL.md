---
name: autonomous-agent-harness
description: |
  Turn an AI coding-agent runtime into a fully autonomous agent system with persistent memory, scheduled operations, computer use, and task queuing — replacing standalone frameworks (AutoGPT-style) with the runtime's native scheduler, dispatch, MCP tools, and memory.
  Use when the user wants continuous autonomous operation, scheduled tasks, or a self-directing agent loop.
  Do NOT use for one-off tasks, or when the user has not explicitly approved autonomous, scheduled, or external side effects.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "ai-agents automation scheduling autonomous memory"
  category: "ai-machine-learning"
  subcategory: "applied-ai"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# Autonomous Agent Harness

Turn an AI coding-agent runtime into a persistent, self-directing agent system using only native features and MCP servers.

## Consent and Safety Boundaries

Autonomous operation must be explicitly requested and scoped by the user. Do not create schedules, dispatch remote agents, write persistent memory, use computer control, post externally, modify third-party resources, or act on private communications unless the user has approved that capability and the target workspace for the current setup.

Prefer dry-run plans and local queue files before enabling recurring or event-driven actions. Keep credentials, private workspace exports, personal datasets, and account-specific automations out of reusable, shareable artifacts.

## When to Activate

- User wants an agent that runs continuously or on a schedule
- Setting up automated workflows that trigger periodically
- Building a personal AI assistant that remembers context across sessions
- User says "run this every day", "check on this regularly", "keep monitoring"
- Wants to replicate functionality from a standalone autonomous agent framework
- Needs computer use combined with scheduled execution

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Agent Runtime                             │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │
│  │ Scheduler│  │ Dispatch │  │ Memory   │  │ Computer    │ │
│  │ Schedule │  │ Remote   │  │ Store    │  │ Use         │ │
│  │ Tasks    │  │ Agents   │  │          │  │             │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬──────┘ │
│       │              │             │                │        │
│       ▼              ▼             ▼                ▼        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              Skill + Agent Layer                     │    │
│  │                                                      │    │
│  │  skills/     agents/     workflows/     hooks/       │    │
│  └──────────────────────────────────────────────────────┘    │
│       │              │             │                │        │
│       ▼              ▼             ▼                ▼        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              MCP Server Layer                        │    │
│  │                                                      │    │
│  │  memory    vcs    search    database    browser-use  │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Persistent Memory

Use the runtime's built-in memory system enhanced with an MCP memory server for structured data.

**Built-in memory** (a project memory directory the runtime auto-loads):
- User preferences, feedback, project context
- Stored as markdown files with frontmatter
- Automatically loaded at session start

**MCP memory server** (structured knowledge graph):
- Entities, relations, observations
- Queryable graph structure
- Cross-session persistence

**Memory patterns:**

```
# Short-term: current session context
Use the in-session task list for tracking

# Medium-term: project memory files
Write to the project memory directory for cross-session recall

# Long-term: MCP knowledge graph
Use the memory server's create-entities for permanent structured data
Use create-relations for relationship mapping
Use add-observations for new facts about known entities
```

### 2. Scheduled Operations

Use the runtime's scheduled-task tooling to create recurring agent operations.

**Setting up a scheduled task (via a scheduler MCP tool):**

```
create_scheduled_task({
  name: "daily-pr-review",
  schedule: "0 9 * * 1-5",  # 9 AM weekdays
  prompt: "Review all open PRs in the target repo. For each: check CI status, review changes, flag issues. Post summary to memory.",
  project_dir: "/path/to/repo"
})
```

For programmatic (headless) runs, invoke your harness's non-interactive mode with a prompt piped or passed in, exiting when done.

**Useful schedule patterns:**

| Pattern | Schedule | Use Case |
|---------|----------|----------|
| Daily standup | `0 9 * * 1-5` | Review PRs, issues, deploy status |
| Weekly review | `0 10 * * 1` | Code quality metrics, test coverage |
| Hourly monitor | `0 * * * *` | Production health, error rate checks |
| Nightly build | `0 2 * * *` | Run full test suite, security scan |
| Pre-meeting | `*/30 * * * *` | Prepare context for upcoming meetings |

### 3. Dispatch / Remote Agents

Trigger agent runs remotely for event-driven workflows.

**Dispatch patterns:**

```bash
# Trigger from CI/CD (generic dispatch endpoint)
curl -X POST "$AGENT_DISPATCH_URL" \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -d '{"prompt": "Build failed on main. Diagnose and fix.", "project": "/repo"}'

# Trigger from webhook
# VCS webhook → dispatch → agent → fix → PR

# Trigger from another agent (headless run)
agent-run -p "Analyze the output of the security scan and create issues for findings"
```

### 4. Computer Use

Leverage a computer-use MCP for real-world interaction.

**Capabilities:**
- Browser automation (navigate, click, fill forms, screenshot)
- Desktop control (open apps, type, mouse control)
- File system operations beyond CLI

**Use cases within the harness:**
- Automated testing of web UIs
- Form filling and data entry
- Screenshot-based monitoring
- Multi-app workflows

### 5. Task Queue

Manage a persistent queue of tasks that survive session boundaries.

**Implementation:**

```
# Task persistence via memory
Write the task queue to the project memory directory (task-queue.md)

# Task format
---
name: task-queue
type: project
description: Persistent task queue for autonomous operation
---

## Active Tasks
- [ ] PR #123: Review and approve if CI green
- [ ] Monitor deploy: check /health every 30 min for 2 hours
- [ ] Research: Find 5 leads in AI tooling space

## Completed
- [x] Daily standup: reviewed 3 PRs, 2 issues
```

## Replacing a Standalone Agent Framework

| Framework Component | Runtime Equivalent | How |
|------------------|---------------|-----|
| Gateway/Router | Dispatch + scheduled tasks | Scheduled tasks trigger agent sessions |
| Memory System | Built-in memory + MCP memory server | Built-in persistence + knowledge graph |
| Tool Registry | MCP servers | Dynamically loaded tool providers |
| Orchestration | Skills + agents | Skill definitions direct agent behavior |
| Computer Use | computer-use MCP | Native browser and desktop control |
| Context Manager | Session management + memory | Session lifecycle |
| Task Queue | Memory-persisted task list | In-session list + memory files |

## Setup Guide

### Step 1: Configure MCP Servers

Ensure a memory server, a scheduler server, and (optionally) a computer-use server are registered in your host's MCP configuration. Consult your host's documentation for the exact config surface and server package names.

### Step 2: Create Base Schedules

```bash
# Daily morning briefing
agent-run -p "Create a scheduled task: every weekday at 9am, review my notifications, open PRs, and calendar. Write a morning briefing to memory."

# Continuous learning
agent-run -p "Create a scheduled task: every Sunday at 8pm, extract patterns from this week's sessions and update the learned skills."
```

### Step 3: Initialize Memory Graph

```bash
# Bootstrap your identity and context
agent-run -p "Create memory entities for: me (user profile), my projects, my key contacts. Add observations about current priorities."
```

### Step 4: Enable Computer Use (Optional)

Grant the computer-use MCP the necessary permissions for browser and desktop control.

## Example Workflows

### Autonomous PR Reviewer
```
Schedule: every 30 min during work hours
1. Check for new PRs on watched repos
2. For each new PR:
   - Pull branch locally
   - Run tests
   - Review changes with a code-review agent
   - Post review comments via the VCS MCP
3. Update memory with review status
```

### Personal Research Agent
```
Schedule: daily at 6 AM
1. Check saved search queries in memory
2. Run searches for each query
3. Summarize new findings
4. Compare against yesterday's results
5. Write digest to memory
6. Flag high-priority items for morning review
```

### Meeting Prep Agent
```
Trigger: 30 min before each calendar event
1. Read calendar event details
2. Search memory for context on attendees
3. Pull recent email/chat threads with attendees
4. Prepare talking points and agenda suggestions
5. Write prep doc to memory
```

## Constraints

- Scheduled tasks run in isolated sessions — they don't share context with interactive sessions unless through memory.
- Computer use requires explicit permission grants. Don't assume access.
- Remote dispatch may have rate limits. Design schedules with appropriate intervals.
- Memory files should be kept concise. Archive old data rather than letting files grow unbounded.
- Always verify that scheduled tasks completed successfully. Add error handling to scheduled prompts.
