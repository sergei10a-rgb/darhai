# Review: durable_goals_v1

Verdict: **needs-work** - 8 findings

## [HIGH] `GoalCursorRegistry.refuse()` correlates a refusal on `request_id` alone and ignores `goal_id`/`session_id`, so a refusal that names a different goal is attributed to the wrong command AND leaves the goal whose command was actually refused unlocked. Measured with tsx against the real module: send goal_advance for goal-001, deliver a refusal with that request_id but goal_id 'goal-SOMEONE-ELSE'/session 'session-OTHER' -> frame reports refusedCommand: 'goal_advance' for a goal that never sent one; needsResync('session-desktop-001','goal-001') === false; buildGoalAdvance for goal-001 still returns ok:true on the very cursor the engine just rejected; and the remembered entry is deleted, so the real refusal for goal-001 will later report 'an unremembered goal command'. The manifest grades this event correlation: 'request_id_and_goal_id' (both fields), the module's own comment at line 146 states that rule, and `RecentRequest` already stores sessionId/goalId - they are written by remember() and never read. No test drives a mismatched refusal.

**Where:** src/process/agent/wcore/capabilities/durableGoals.ts:761-768 (refuse(), `const matched = this.recent.get(requestId)`), consumed at :1373

**Why it matters:** This is the exact failure the module says it exists to prevent - 'repeating a control command against a cursor the engine has already rejected' - on the one event the manifest grades criticality: 'safety'. It defeats the lock on the correct goal and simultaneously locks an unrelated one.

## [HIGH] The `needsResync` re-seed branch in observe() adopts the next cursor unconditionally, including one that moves strictly BACKWARDS, and clears the lock. Measured: seed at journal_sequence 500 -> deliver events/goal_control_refused.json (needsResync true) -> deliver a snapshot at sequence 10 -> verdict 'seeded', adopted true, needsResync back to false, and buildGoalAdvance then emits cursor {journal_digest:'digest-10', journal_sequence:10}. The flag is set by EVERY refusal (refuse() line 764), not only after the host actually sent goal_resync, so this is reachable on ordinary duplicate or out-of-order snapshot delivery - which the module's own header notes the contract leaves undeclared. The branch sits above the stale_replay/digest_conflict/state_conflict checks, so all of that discipline is bypassed for the first observation after any refusal. The only re-seed test uses a forward cursor (41 > 40), so nothing covers the backwards case.

**Where:** src/process/agent/wcore/capabilities/durableGoals.ts:685-698 (observe(), `if (state.needsResync)` branch)

**Why it matters:** Arms a guaranteed-stale cursor on the safety-class control path and can livelock: refusal -> backwards re-seed -> advance on the old cursor -> refusal. The module already remembers request ids, so gating the re-seed on the outstanding goal_resync request_id (or on sequence >= held) is available and unused.

## [MEDIUM] `goal_control_refused` carries a wire-controlled `goal_id`, and refuse() calls ensure() for it before anything establishes the goal is known - so a refusal for an unknown goal allocates a registry slot and, at MAX_TRACKED_GOALS, evicts a real goal's cursor insertion-order and silently (no ctx.warn on eviction). Measured: after one real goal_snapshot for goal-001, feeding 64 refusals with goal_id ghost-0..63 leaves trackedKeys().length === 64 and cursorFor('session-desktop-001','goal-001') === null; buildGoalAdvance then refuses with 'no cursor has been published'. The eviction comment at :791 also contradicts the rationale at :121-124, which argues against dropping a cursor still needed to CANCEL a live goal - insertion-order eviction drops exactly the oldest, i.e. longest-running, goal first.

**Where:** src/process/agent/wcore/capabilities/durableGoals.ts:762 (refuse -> ensure) and :790-794 (ensure eviction)

**Why it matters:** Wire-controlled denial of the goal control path: the user can no longer advance or cancel a live goal, and nothing in the log says why the cursor disappeared. Fail-closed rather than unsafe, but it is an availability defect on a safety capability.

## [MEDIUM] `task.depends_on` is copied out of the payload with no cap, while `tasks` is capped at MAX_TASKS_PER_GOAL for exactly this stated reason ('Copying an unbounded array into long-lived state is the leak'). Measured: a snapshot whose single task carries 50000 depends_on entries yields recordFor(...).tasks[0].depends_on.length === 50000 retained in GoalState.record, and toTaskSummaries puts the same 50000-element array on the emitted frame, which is what crosses the IPC boundary to the renderer. Worst case is 64 goals x 256 tasks x unbounded depends_on, all engine-supplied.

**Where:** src/process/agent/wcore/capabilities/durableGoals.ts:406-408 (parseTask depends_on) and :1291 (toTaskSummaries `summary.dependsOn = task.depends_on`)

**Why it matters:** Contradicts the module's own bounding rule for the sibling field, in a module singleton with no teardown hook. The retained payload and the IPC frame are both sized by the engine, not by the host.

## [MEDIUM] The claim '28 mutations applied mechanically ... 28/28 KILLED - no guard survived, so none is decoration' does not generalize. I re-ran the four named mutations (they reproduce exactly: 6, 12, 5 and 2 red respectively) and then applied 21 the author did not name; 17 were killed and 4 SURVIVED with the suite fully green at 120/120: (a) removing the `objective !== undefined` guard in adopt() so a later record-less snapshot blanks the objective; (b) removing the `lifecycleState !== undefined` guard likewise; (c) dropping the string filter on `depends_on` in parseTask so non-string wire entries reach the frame; (d) removing `state.goalVersion = goalVersion` from refuse(). Harness validity was itself checked: my first run used `--reporter=basic`, which does not exist in Vitest 4, so every run failed for a non-test reason and everything falsely read KILLED - a comment-only control mutation caught it and correctly SURVIVES after the fix.

**Where:** tests/unit/wcore-durableGoals.test.ts (whole file); surviving guards at src/process/agent/wcore/capabilities/durableGoals.ts:826, :828, :407, :763

**Why it matters:** Four real guards are currently unverified, so a refactor can delete any of them silently. The stated conclusion invites exactly that trust.

## [LOW] `idempotency_key` is policed by GOAL_ID_PATTERN, borrowed from continue_with_budget's request_id. The schema declares it a bare `type: string` with no pattern, and unlike request_id it is CALLER-supplied, not host-minted. Measured: 'sha256:abc/def+ghi=' and 'idem publish' are both refused; only the dash/dot/colon/underscore charset under 128 chars is accepted. Idempotency keys are commonly hashes or base64.

**Where:** src/process/agent/wcore/capabilities/durableGoals.ts:1029-1033 (buildGoalDeclareTask, idFault('idempotency_key', ...))

**Why it matters:** Fail-closed, so not unsafe, but it refuses commands the contract permits, and the borrowed-pattern justification at :155-171 is argued for correlation ids the host mints - it does not carry over to a caller-supplied idempotency key.

## [LOW] Two accuracy slips in the stated fixture coverage. The claim 'all four adversarial/recovery/*.jsonl borrowed for cursor semantics' is off by one: that directory ships FIVE files (cursor-digest-mismatch, cursor-gap, state-digest-conflict, valid-replay, version-mismatch); version-mismatch.jsonl is not driven. Separately, the test at line 1083 asserts only `expect(refusal(outcome).length).toBeGreaterThan(0)` for all ten goal_open rejection cases - since every reason string in the module is non-empty, that adds nothing beyond refusal() not throwing, so a validator that rejects the right input for the wrong field still passes.

**Where:** tests/fixtures/engine-contract/desktop/v1/adversarial/recovery/ (5 files, 4 used); tests/unit/wcore-durableGoals.test.ts:1073-1084

**Why it matters:** The file's whole method is 'name the evidence each rule rests on', so an overstated inventory and a near-vacuous assertion weaken the audit trail the next reviewer inherits.

## [LOW] The capability is unreachable in the running app and its frames would be dropped even if it were reached. It is not in HANDLERS (src/process/agent/wcore/capabilities/index.ts:38-43), so dispatchCapabilityEvent never routes a goal event to it; and WCoreManager forwards above the `if (!data.msg_id) return;` guard only for types in CAPABILITY_FRAME_TYPES, which is derived from the capability registry - so every frame emitted here with msg_id '' is dropped today. The author discloses both in the header (WIRING note, items 1 and 2), so this is confirmation rather than a new defect.

**Where:** src/process/agent/wcore/capabilities/index.ts:38-43 and src/process/task/WCoreManager.ts:1081-1093

**Why it matters:** Nothing in this module runs in production until registration lands, so none of the safety behaviour above is live yet - worth stating plainly so 'tests green' is not read as 'shipped'.
