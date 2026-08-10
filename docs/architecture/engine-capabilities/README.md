# Engine capabilities: opening everything v0.12.26 offers

The engine's `desktop-contract-v1` defines 23 commands and 52 events. Darhai
implemented 9 commands and 33 events — **34 verbs unused, 32 of them carrying
the contract's own `safety` criticality**. This directory tracks closing that
gap completely.

## How the work was scoped

Nine research agents each read the full contract for one capability against
Darhai's existing code and produced a plan precise enough to implement from.
Those plans are the `*.json` files here — exact TypeScript definitions derived
field-by-field from the JSON Schema, the files to touch, which adversarial
fixtures prove what, and a `risks` array stating what the contract does **not**
settle.

Totals across the nine: **59 protocol types, ~124 hours, 83 adversarial
fixtures to drive.**

Read `_index.json` for the summary table.

## The foundation (landed first, everything stands on it)

| Piece | What it gives every capability |
|---|---|
| `tests/fixtures/engine-contract/` | The contract in-tree: 23 commands, 52 events, schemas, 83 fixtures. Offline, versioned, diffable. |
| `tests/unit/engineContractVersion.test.ts` | The bundle must describe the engine the build ships. Fails on drift. |
| `tests/helpers/engineContract.ts` | One place to read the manifest, an example payload, a subsystem's fixtures, and validate against the published schema (draft 2020-12). |
| `src/process/agent/wcore/capabilities/` | Extension point. Each capability is a module claiming its own event types; the decoder routes to it. A throwing handler is contained. Two handlers may not claim one type. |
| `.../capabilities/contractNegotiation.ts` | What **this** engine build supports. Gates every command — sending a gated verb to a build that graded it `shape_only` buys a turn that waits forever. |

Why an extension point rather than more `switch` arms: `WCoreAgent.handleEvent`
is one switch in an 1100-line file, `src/process/agent/wcore/` was already at
the 10-file limit AGENTS.md sets, and nine subsystems landing there would mean
one unreadable file, one merge conflict per change, one blast radius.

## Rules the implementation follows

1. **The contract is primary, the plan is secondary.** Field names and
   optionality come from `schema/core-event.schema.json`, not from a name that
   looks right.
2. **Drive the real fixtures.** A hand-rolled payload that resembles
   `cursor-gap.jsonl` proves nothing about the engine. Load the file.
3. **Justify each verdict.** For every adversarial fixture, decide accept /
   reject / ignore and justify it from the contract — `criticality`,
   `correlation`, the schema. Never from the filename: `duplicate-identical` is
   a case a host should tolerate, `noncritical` describes a flag not a verdict.
4. **Mutation-proof the guards.** Break the central check, watch the named tests
   go red, restore. A guard whose test cannot fail is not a guard.
5. **Fail closed where the contract is silent** — and say in a comment that the
   silence was noticed and which way it was resolved.

## Waves

Ordered by dependency, not by size. `contract_negotiation` gates three of them
and landed first; `host_delegated_delivery` needs turn recovery's cursor type
and lands last.

| Wave | Capabilities | State |
|---|---|---|
| 0 | contract negotiation, dispatcher, contract harness | ✅ landed |
| 1 | execution policy · workflow lifecycle · anvil receipts · budget grants | in progress |
| 2 | turn recovery · durable goals · runtime diagnostics + MCP lifecycle · capability activation | pending |
| 3 | host-delegated delivery + failover receipts + tool-effect resolution | pending (needs wave 2) |
| 4 | UI surfaces + i18n for every capability that earns one | pending |

Each wave is implement-then-adversarially-review: a second agent tries to break
what the first built, re-runs the mutation proof itself, and reports rather than
patches.

## What the research turned up that changes plans

- **`execution_policy` is the only `critical: true` event in the contract.** It
  publishes the engine's effective security posture with a monotonic revision,
  and six fixtures define what a host does with a revision gap or a conflicting
  duplicate.
- **Recovery is host-initiated.** The engine never volunteers a snapshot: every
  recovery event carries a `request_id` that only the host's `session_resync`
  mints. Nothing recovers today because Darhai never asks.
- **`[compact] smart_enabled = true` turns on the engine's smart-handoff
  capability** — measured, not inferred. Three other capabilities report
  `disabled_by_config` and their gates were **not** found; the research says so
  plainly instead of guessing, and no toggle ships for them.
- **`delegate_isolation` is a platform fact, not a setting.** Its reason is
  `isolation_not_enforced`, a different token from `disabled_by_config`. Report
  it; do not offer to "fix" it.
