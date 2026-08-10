# Review: turn_recovery_v1

Verdict: **needs-work** - 8 findings

## [HIGH] The frame's `actionable` flag is documented as "deliberately FALSE for the live turn_recovery_lifecycle feed" (turnRecovery.ts:466-475) but `toFrame` never checks the event type — it is computed purely from `verdict === 'applied' && pendingTurn !== null && cursor !== null`. Worse, on that path it pairs a STALE `pendingTurn` from an earlier snapshot with the LIVE cursor the lifecycle event just advanced to.

**Where:** src/process/agent/wcore/capabilities/turnRecovery.ts:1496-1500 (toFrame), invariant claimed at :466-475, announce path at :1608-1616

**Why it matters:** MEASURED, probe passed: dispatch the snapshot example (pending_turn turn-002, cursor 4444..@40), then `turn_recovery_lifecycle{turn_id:'turn-999', reconcile_reason:'tool_outcome_unknown', cursor 6666..@42}`. Second frame comes out `{actionable:true, pendingTurn.turn_id:'turn-002', cursor:{6666..,42}}`. The host tells the UI it may offer reconcile/cancel for a turn the engine is still running, and the compare-and-swap token it hands to `buildResumeTurn` is a journal position that belongs to a different turn than the `turn_id` beside it — for a safety-class command whose whole purpose is compare-and-swap. The only shipped test of this invariant (test:1080-1094) runs with no prior snapshot, so `pendingTurn` is null and `actionable` is false for the wrong reason; mutation NEW-D (deleting `!decision.unusable` from the same expression) also survived.

## [HIGH] The unsolicited-answer correlation guard is disabled on exactly the engines the contract gate refuses. `accept` only refuses an unminted `request_id` when `this.askedThisProcess` is true, and that flag is set only by `noteResyncRequest`, which is reached only AFTER `beginResync` passes `canRecoverSessions`. Gate shut => no ask => guard never arms => every volunteered snapshot/replay/unavailable is adopted unconditionally. Nothing gates inbound adoption, cursor persistence, or `actionable` on the capability grade.

**Where:** src/process/agent/wcore/capabilities/turnRecovery.ts:895 (`if (this.askedThisProcess && ...)`), :823-830 (noteResyncRequest), :1522-1528 (the gate), :1573-1575 (persist on applied)

**Why it matters:** MEASURED, probe passed: seed `ready` with `turn_recovery_v1: 'shape_only'`. `canResync` false and `beginResync` correctly sends nothing — then dispatch the engine's `session_recovery_snapshot` with `request_id: 'recovery-request-001'` (never minted). Result: cursor adopted as 4444..@40, `cursorSink` called with that cursor (written to disk for the next start's `after`), frame `actionable:true`, and `ctx.warns` is EMPTY. Same holds when `ready` was never seeded (the fail-closed default) or persistence is not `durable`. A safety-class capability accepts by default from precisely the builds it decided it cannot talk to. Test:929 pins this as intended; mutation NEW-H (removing the `askedThisProcess` precondition) breaks 6 tests because every shipped fixture uses an unminted request_id, so the fixtures cannot exercise the guard at all.

## [MEDIUM] The `unusable` latch — documented as "recovery for this session is refused from here on" and the entire conservative half of the state-conflict rule — is erased by session eviction, which is driven by wire-supplied `session_id`. `handle` calls `trackerFor(sessionId)` before any validation, so any recovery event with a novel session id allocates a tracker; 33 of them evict the latched one.

**Where:** src/process/agent/wcore/capabilities/turnRecovery.ts:1454-1466 (trackerFor eviction) reached from :1570 (handle) before `accept` validates anything

**Why it matters:** MEASURED, probe passed: run `adversarial/recovery/state-digest-conflict.jsonl` -> session-desktop-001 latches unusable and a third well-formed message warns `rejected_session_unusable`. Then dispatch 33 events with `session_id: flood-0..32`. Re-send the SAME conflicting body: verdict `applied`, cursor 4444..@40, and no 'unusable' warning anywhere. A misbehaving engine reopens a session the host refused, using nothing but session ids it controls. The same eviction silently discards live sessions' in-memory cursors, and mutation NEW-L shows dropping `contracts.delete(oldest)` is untested too. The shipped latch test (test:511-522) exercises a bare `SessionRecoveryTracker`, which eviction cannot reach.

## [MEDIUM] The mutation-proof guard inventory is incomplete. I reproduced both named representatives (CAUGHT), then mutated 14 guards the author did not: 10 SURVIVED with the suite fully green — `advanceLiveCursor` `<=`->`<`; `sameCursor` sequence equality deleted; `parseCursor` unknown-key refusal restricted to the outbound `after`; `parseBudget` `cost_used_usd` type/finiteness; `parseBudget` `token_limit` integer; `parsePendingTurn` `msg_id`/`pending_call_id` string checks; `toFrame`'s `!decision.unusable`; the `turns` LRU `delete`-before-`set`; `canonicalJson` depth `>=`->`>`; `trackerFor`'s `contracts.delete(oldest)`.

**Where:** src/process/agent/wcore/capabilities/turnRecovery.ts:1193, :706-707, :584-587, :606-608, :615, :647-654, :1500, :1143, :679, :1459

**Why it matters:** Two of these are guards the file's own prose argues hardest for. (a) `advanceLiveCursor`'s `<=` is the only thing refusing an equal-sequence/different-digest cursor, which :1176-1180 calls "a contradiction" that would write an `after` the next start cannot place — changing it to `<` adopts the contradiction and no test notices (probe 4 confirms the current refusal is real behaviour, just unverified). (b) `parseCursor` refuses unknown keys because the cursor subschema is the ONE `additionalProperties:false` object in the surface (:566-575); the only test (test:398) drives the OUTBOUND `after`, so restricting the check to `where === 'after'` leaves every INBOUND wire cursor accepting undeclared fields, green. "36/36 caught, 0 survivors" is true of the 36 chosen and is not evidence of coverage.

## [LOW] `toFrame`'s `!decision.unusable` term in `actionable` is unreachable dead code: `applied()` hardcodes `unusable: false` and `actionable` already requires `verdict === 'applied'`.

**Where:** src/process/agent/wcore/capabilities/turnRecovery.ts:1500 with :1199-1213 (`applied()` returns `unusable: false`)

**Why it matters:** MEASURED: mutation NEW-D deleted the term and all 97 tests stayed green. The JSDoc at :466-475 advertises "a usable session" as one of three preconditions, but that precondition is satisfied by a literal rather than by tracker state — so a future refactor that lets an applied decision carry `unusable: true` would silently mark a refused session actionable, with no test standing in the way.

## [LOW] `session_recovery_unavailable` clears the held cursor and persists `null` for ALL nine reasons, including `snapshot_unavailable`, `session_not_found` and `journal_corrupt`, whose justification comment ("the cursor the host sent is the one the engine just refused") only holds for the four `GENESIS_RETRYABLE` reasons.

**Where:** src/process/agent/wcore/capabilities/turnRecovery.ts:1090-1096 and :1582 (`persist(sessionId, null, ctx)`)

**Why it matters:** MEASURED, probe passed: apply the snapshot (cursor 4444..@40 written to the sink), then `session_recovery_unavailable{reason:'snapshot_unavailable'}` — the sink receives `null` and `latestCursor` goes null. A transient inability to produce a snapshot destroys the only durable journal position the capability exists to maintain, and it is not recoverable from the reason itself. The shipped test (test:823-834) asserts only that no retry is sent for those five reasons; it never checks what happened to the cursor.

## [LOW] `request_id`s are added to `outstanding` and never retired — `accept` does not delete a matched id after answering it. The getter's own doc says "minted and not yet retired".

**Where:** src/process/agent/wcore/capabilities/turnRecovery.ts:784, :810-813, :823-830, consumed at :895

**Why it matters:** A `request_id` stays valid for the life of the process, so the correlation check degrades to permanent set membership: a frame replayed minutes later under an already-answered id passes rule 3 and is graded on content alone. Combined with the `MAX_OUTSTANDING_RESYNCS` FIFO eviction this also means the ledger holds the 8 most recently minted ids regardless of whether any were ever answered, so a genuine late answer to ask #1 is refused while a stale duplicate of ask #8 is accepted.

## [LOW] Roughly 12 of the 97 tests assert only facts about the fixture bundle and would remain green if turnRecovery.ts were deleted entirely.

**Where:** tests/unit/wcore-turnRecovery.test.ts:178, :195, :208, :218, :227, :235, :243, :265, :367, :551, :573, :577

**Why it matters:** e.g. test:367 ("no engine event in the contract produces an approval_id") reads the manifest and every event fixture and asserts the filtered list is empty — it never touches the module under test. These are legitimate contract-drift gates and I am not calling them wrong, but they inflate the headline count: the number of tests that actually constrain the implementation is meaningfully below 97, which matters when 97/97 is offered as the coverage claim alongside a mutation proof whose guard set turned out to be incomplete.
