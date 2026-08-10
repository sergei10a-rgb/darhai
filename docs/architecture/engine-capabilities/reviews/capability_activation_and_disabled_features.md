# Review: capability_activation_and_disabled_features

Verdict: **needs-work** - 8 findings

## [HIGH] `outcome_changed` — the one stage this module's own docstring names as "a capability that was `ready` genuinely stops being `ready`" — is treated as a healthy step at runtime. The only warning gate is `if (stage === UNAVAILABLE)` (line 385) and the only regression flag is `unavailable: accepted.row.stage === UNAVAILABLE` (line 476). MEASURED probe: feeding `{capability:'delegate_isolation', stage:'ready'}` then `{capability:'delegate_isolation', stage:'outcome_changed', reason:'isolation_not_enforced'}` produces warnCount=0, two `ctx.log` lines, and an emitted frame `{stage:'outcome_changed', reason:'isolation_not_enforced', unavailable:false, remedy:'not_configurable'}`. The row records `remedy: not_configurable` — the module grades the reason as a platform failure and simultaneously tells the renderer the capability is fine. `CapabilityActivationFrame.unavailable` is documented as "True when the engine declined to activate this capability" and the test at line 300-309 calls it "what a readout keys its warning styling off".

**Where:** src/process/agent/wcore/capabilities/capabilityActivation.ts:385, 476 (guard is `stage === UNAVAILABLE` only); type union declares `outcome_changed` at line 106; no test covers it carrying a reason

**Why it matters:** The module's stated reason for existing is that `delegate_isolation: isolation_not_enforced` is "a safety statement the user cannot see today" (lines 29-31). A mid-session `outcome_changed` carrying that exact token renders as a healthy capability with no warning — the same invisibility, reintroduced by the decoder instead of by the acknowledged-unhandled list. Nothing in the 49 tests exercises `outcome_changed` with a reason; the one test that touches the stage (line 318) passes `reason: undefined` and only asserts msg_id.

## [HIGH] Any `unavailable` capability arriving after the 64-row cap is logged at info level as if it were a healthy step, and is not recorded. The overflow branch (lines 360-369) returns BEFORE the `stage === UNAVAILABLE` warning block, so the only warning it can produce is the generic "record is full" line — which fires once per process (`const first = !this.overflowed`). MEASURED probe: fill 64 rows, send one over-cap frame (consumes the single overflow warn), then send `{capability:'delegate_isolation', stage:'unavailable', reason:'isolation_not_enforced'}` → warnCount=0, logs=["[capability_activation] delegate_isolation -> unavailable"], not in `snapshot().rows`.

**Where:** src/process/agent/wcore/capabilities/capabilityActivation.ts:360-369 (early return skips the warn block at 384-393); handler else-branch at line 467 logs it

**Why it matters:** The wire chooses the `capability` key, so an engine that emits 64 junk ids before the real ones pushes every genuine unavailability into this path. The bound itself is correct and disclosed via `overflowed`, but what it drops is precisely the safety signal, downgraded to an info log that reads identically to `mid_flight_monitor -> ready`. The two overflow tests (lines 492-524) only use `stage: 'ready'`, so no test covers an unavailable capability past the cap.

## [MEDIUM] The warn-dedupe key `${stage}|${reason ?? ''}` is stored in `lastWarned` and is never cleared when the capability leaves `unavailable`, so a capability that fails, recovers, then fails again the same way warns only once. MEASURED probe: `unavailable/isolation_not_enforced` → `ready` → `unavailable/isolation_not_enforced` gives warnCount=1 (the final row is correct: stage=unavailable, frames=3). The docstring at lines 381-383 promises the opposite: "A CHANGED stage or reason is a new outcome and does warn again."

**Where:** src/process/agent/wcore/capabilities/capabilityActivation.ts:377 (`lastWarned: existing?.lastWarned ?? ''`) and 386-388

**Why it matters:** Compounds the previous two findings: after an `outcome_changed` regression the follow-up `unavailable` frame — the one that would have been loud — is deduped away because the identical outcome was already reported at boot. The state that dedupe should key on is "was the last reported outcome this one", not "has this outcome ever been reported".

## [MEDIUM] The test named `reset clears the rows, the overflow flag and the announce budget` (lines 558-570) proves only the rows. It replays the default capture (8 rows, 24 announced frames, never overflows, never exhausts the 256 budget), so the pre-reset state of `overflowed`/`announced`/`budgetWarned` is already the post-reset state. I mutated each of the three assignments out of `reset()` one at a time and re-ran the file: N1 `this.overflowed = false;` removed → 0 failing. N2 `this.announced = 0;` removed → 0 failing. N3 `this.budgetWarned = false;` removed → 0 failing. All three are silent guards. (The shipped code is correct — probes confirm reset does restore both — the guards are simply untested.)

**Where:** tests/unit/wcore-capabilityActivation.test.ts:558-570 vs src/process/agent/wcore/capabilities/capabilityActivation.ts:313-318

**Why it matters:** The author's mutation wave covered `this.rows.clear()` (M10) and stopped there, so the report reads as if reset were fully proved. The consequences the test's own comment names are real: without the `announced` reset a long-lived app stops forwarding activation frames after a few engine respawns ("or a long-lived app would stop announcing after a few restarts" — line 565-566, asserted nowhere); without the `overflowed` reset the UI permanently claims the readiness record is incomplete for a healthy engine.

## [LOW] Two more silent guards in the overflow branch: mutating `frames: 0` → `frames: 42` (N5) and `remedy: remedyFor(reason)` → `remedy: 'unknown'` (N6) both leave all 49 tests green. The refused-overflow row is returned to the handler, passed to `ctx.warn(..., accepted.row)` and drives the emitted frame's `remedy`, but nothing asserts either field.

**Where:** src/process/agent/wcore/capabilities/capabilityActivation.ts:364; tests/unit/wcore-capabilityActivation.test.ts:492-524

**Why it matters:** The over-cap frame IS still emitted to the renderer (probe confirms `{capability:'delegate_isolation', unavailable:true, remedy:'not_configurable'}` reaches `ctx.emit`), so its `remedy` is user-visible. A regression that graded every refused capability `unknown` — i.e. hid an opt-out that a settings pane could act on — would ship green.

## [LOW] Three assertions carry less weight than their prose. (a) `expect(a.record.snapshot()).toEqual(a.snapshot())` (line 582) is a tautology — `snapshot()` is literally `return record.snapshot()`, so it cannot fail. (b) `expect(capabilityActivationCapability.name).toBeTruthy()` (line 680) accepts any non-empty string. (c) `expect(surfaceOf(EVENT))` (line 168) passes an event type into a function whose parameter is a capability id; `capability_activation` is not among the manifest's 17 capability names, so it returns `{events:[],commands:[]}` regardless of what the contract says about the event.

**Where:** tests/unit/wcore-capabilityActivation.test.ts:168, 582, 680

**Why it matters:** Each is presented as a guard in a file whose whole argument is that nothing is asserted without justification. They inflate the 49-test count without adding failure modes.

## [LOW] The test `forwards one frame per accepted event, under a type it claims` (line 283-310) explains itself with "`WCoreManager` builds its pass-through set from `claimedEventTypes()`", but asserts `expect(cap.handles).toContain(f.type)` — the capability's own array, not the manager's set. Because this module is not in `HANDLERS`, `claimedEventTypes()` does not contain `capability_activation`, so `CAPABILITY_FRAME_TYPES` (src/process/task/WCoreManager.ts:50) does not either and every frame this module emits would be dropped at WCoreManager.ts:1081 today.

**Where:** tests/unit/wcore-capabilityActivation.test.ts:287 vs src/process/task/WCoreManager.ts:50, 1081

**Why it matters:** The unwired state is disclosed honestly in the header, and `wcore-capabilityFrameForwarding.test.ts:61` covers registered capabilities only — so nothing is lying. But the assertion written here does not test the invariant its comment names, and M12 (which changed only the emit string) passing is not evidence that it does.

## [LOW] The observed README attributes the capture to `wayland-core.exe` "sha256 `6840f56a…33df`, per the bundle manifest". That hash is `source.sha256` in resources/bundled-wayland-core/win32-x64/manifest.json — the sha of the downloaded release ZIP. The exe's own sha256 is `11b07ffefb22ad70a17def199b1eca8b06aa20f457e13994f25cfa8e6b4f02bc` (measured).

**Where:** tests/fixtures/engine-contract/desktop/v1/observed/README.md, capture-provenance paragraph

**Why it matters:** The README instructs "Re-capture both with the commands above after every engine bump", so the next person will hash the binary to confirm they are on the same engine and get a mismatch against the only hash printed. The attribution clause makes it defensible, not useful.
