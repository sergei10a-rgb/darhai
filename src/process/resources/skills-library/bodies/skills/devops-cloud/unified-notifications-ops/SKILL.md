---
name: unified-notifications-ops
description: |
  Turn scattered events into one operator notification surface with clear severity, ownership, routing, and follow-up: capture, classify, route, collapse duplicates, and attach the next action across issue/project trackers, local hooks, desktop alerts, and connected chat/email.
  Use when the real problem is alert routing, deduplication, escalation, or inbox collapse rather than a single missing ping.
  Do NOT fan out every event to every channel, and do NOT invent an external notification product when existing primitives suffice.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "alerting notifications routing observability escalation"
  category: "devops-cloud"
  subcategory: "monitoring-observability"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Unified Notifications Ops

Use this skill when the real problem is not a missing ping. The real problem is a fragmented notification system.

The job is to turn scattered events into one operator surface with:
- clear severity
- clear ownership
- clear routing
- clear follow-up action

## When to Use

- the user wants a unified notification lane across trackers, local hooks, desktop alerts, chat, or email
- CI failures, review requests, issue updates, and operator events are arriving in disconnected places
- the current setup creates noise instead of action
- the user wants to consolidate overlapping notification branches or backlog proposals into one lane
- the workspace already has hooks, MCPs, or connected tools, but no coherent notification policy

## Preferred Surface

Start from what already exists:
- issue tracker: issues, PRs, reviews, comments, and CI
- project tracker: issue/project movement
- local hook events and session lifecycle signals
- desktop notification primitives
- connected email/chat surfaces when they actually exist

Prefer orchestrating native primitives over telling the user to adopt a separate notification product.

## Non-Negotiable Rules

- never expose tokens, secrets, webhook secrets, or internal identifiers
- separate:
  - event source
  - severity
  - routing channel
  - operator action
- default to digest-first when interruption cost is unclear
- do not fan out every event to every channel
- if the real fix is better issue triage, hook policy, or project flow, say so explicitly

## Event Pipeline

Treat the lane as:

1. **Capture** the event
2. **Classify** urgency and owner
3. **Route** to the correct channel
4. **Collapse** duplicates and low-signal churn
5. **Attach** the next operator action

The goal is fewer, better notifications.

## Default Severity Model

| Class | Examples | Default handling |
| --- | --- | --- |
| Critical | broken default-branch CI, security issue, blocked release, failed deploy | interrupt now |
| High | review requested, failing PR, owner-blocking handoff | same-day alert |
| Medium | issue state changes, notable comments, backlog movement | digest or queue |
| Low | repeat successes, routine churn, redundant lifecycle markers | suppress or fold |

If the workspace has no severity model, build one before proposing automation.

## Workflow

### 1. Inventory the current surface

List:
- event sources
- current channels
- existing hooks/scripts that emit alerts
- duplicate paths for the same event
- silent failure cases where important things are not being surfaced

Call out what is already owned.

### 2. Decide what deserves interruption

For each event family, answer:
- who needs to know?
- how fast do they need to know?
- should this interrupt, batch, or just log?

Use these defaults:
- interrupt for release, CI, security, and owner-blocking events
- digest for medium-signal updates
- log-only for telemetry and low-signal lifecycle markers

### 3. Collapse duplicates before adding channels

Look for:
- the same PR event appearing in the issue tracker, project tracker, and local logs
- repeated hook notifications for the same failure
- comments or status churn that should be summarized instead of forwarded raw
- channels that duplicate each other without adding a better action path

Prefer:
- one canonical summary
- one owner
- one primary channel
- one fallback path

### 4. Design the workflow

For each real notification need, define:
- **source**
- **gate**
- **shape**: immediate alert, digest, queue, or dashboard-only
- **channel**
- **action**

If a primitive already exists, prefer:
- a skill for operator triage
- a hook for automatic emission/enforcement
- an agent for delegated classification
- an MCP/connector only when a real bridge is missing

### 5. Return an action-biased design

End with:
- what to keep
- what to suppress
- what to merge
- what to wrap next

## Output Format

```text
CURRENT SURFACE
- sources
- channels
- duplicates
- gaps

EVENT MODEL
- critical
- high
- medium
- low

ROUTING PLAN
- source -> channel
- why
- operator owner

CONSOLIDATION
- suppress
- merge
- canonical summaries

NEXT MOVE
- skill / hook / agent / MCP
- exact workflow to build next
```

## Recommendation Rules

- prefer one strong lane over many weak ones
- prefer digests for medium and low-signal updates
- prefer hooks when the signal should emit automatically
- prefer operator skills when the work is triage, routing, and review-first decision-making
- prefer a project/flow-coordination capability when the root cause is backlog / PR coordination rather than alerts
- prefer a workspace/surface audit when the user first needs a source inventory
- if desktop notifications are enough, do not invent an unnecessary external bridge

## Good Use Cases

- "We have multiple trackers and local hook alerts, but no single operator flow"
- "Our CI failures are noisy and people ignore them"
- "I want one notification policy across all my agent surfaces"
- "Figure out what should interrupt versus land in a digest"
- "Collapse overlapping notification ideas into one canonical lane"

## Related Capabilities

- A workspace/surface audit for source inventory
- A project/flow-coordination capability for backlog and PR coordination
- A VCS/CI capability for tracker and pipeline events
- A durable-context capability for capturing decisions
- A billing/customer-ops capability when the notification pain is billing/customer operations rather than engineering
