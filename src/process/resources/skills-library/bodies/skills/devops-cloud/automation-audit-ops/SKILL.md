---
name: automation-audit-ops
description: |
  An evidence-first automation inventory and overlap audit: surface every live job, hook, connector, MCP server, and wrapper, classify each by live state, back every claim with a concrete proof path, and end with a keep / merge / cut / fix-next recommendation set.
  Use when the user wants to know which automations are live, broken, redundant, or missing before fixing anything.
  Do NOT rewrite or delete overlapping surfaces before the evidence table exists, and do NOT treat "present in config" as "working".
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "automation audit ci-cd inventory operations"
  category: "devops-cloud"
  subcategory: "ci-cd-pipelines"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Automation Audit Ops

Use this when the user asks what automations are live, which jobs are broken, where overlap exists, or what tooling and connectors are actually doing useful work right now.

This is an audit-first operator skill. The job is to produce an evidence-backed inventory and a keep / merge / cut / fix-next recommendation set before rewriting anything.

## Companion Capabilities

Pull these into the workflow when relevant:

- A workspace/surface audit for connector, MCP, hook, and app inventory
- A durable-context capability when the audit needs to reconcile live repo truth with stored context
- A VCS/CI capability when the answer depends on CI, scheduled workflows, issues, or PR automation
- A cost/usage audit when the real problem is webhook fanout, queued jobs, or billing burn
- A research capability when local inventory must be compared against current platform support or public docs
- A verification pass for proving post-fix state instead of relying on assumed recovery

## When to Use

- user asks "what automations do I have", "what is live", "what is broken", or "what overlaps"
- the task spans cron jobs, CI workflows, local hooks, MCP servers, connectors, wrappers, or app integrations
- the user wants to know what was ported from another agent system and what still needs to be rebuilt
- the workspace has accumulated multiple ways to do the same thing and the user wants one canonical lane

## Guardrails

- start read-only unless the user explicitly asked for fixes
- separate:
  - configured
  - authenticated
  - recently verified
  - stale or broken
  - missing entirely
- do not claim a tool is live just because a skill or config references it
- do not merge or delete overlapping surfaces until the evidence table exists

## Workflow

### 1. Inventory the real surface

Read the current live surface before theorizing:

- repo hooks and local hook scripts
- CI and scheduled workflows
- MCP configs and enabled servers
- connector- or app-backed integrations
- wrapper scripts and repo-specific automation entrypoints

Group them by surface:

- local runtime
- repo CI / automation
- connected external systems
- messaging / notifications
- billing / customer operations
- research / monitoring

### 2. Classify each item by live state

For every surfaced automation, mark:

- configured
- authenticated
- recently verified
- stale or broken
- missing

Then classify the problem type:

- active breakage
- auth outage
- stale status
- overlap or redundancy
- missing capability

### 3. Trace the proof path

Back every important claim with a concrete source:

- file path
- workflow run
- hook log
- config entry
- recent command output
- exact failure signature

If the current state is ambiguous, say so directly instead of pretending the audit is complete.

### 4. End with keep / merge / cut / fix-next

For each overlapping or suspect surface, return one call:

- keep
- merge
- cut
- fix next

The value is in collapsing noisy automation into one canonical lane, not in preserving every historical path.

## Output Format

```text
CURRENT SURFACE
- automation
- source
- live state
- proof

FINDINGS
- active breakage
- overlap
- stale status
- missing capability

RECOMMENDATION
- keep
- merge
- cut
- fix next

NEXT MOVE
- exact skill / hook / workflow / app lane to strengthen
```

## Pitfalls

- do not answer from memory when the live inventory can be read
- do not treat "present in config" as "working"
- do not fix lower-value redundancy before naming the broken high-signal path
- do not widen the task into a repo rewrite if the user asked for inventory first

## Verification

- important claims cite a live proof path
- each surfaced automation is labeled with a clear live-state category
- the final recommendation distinguishes keep / merge / cut / fix-next
