---
name: receiving-code-review
description: Use when receiving code review feedback or any structured critique - review comments came back, PR feedback needs addressing, findings need replies - especially before implementing suggestions, or when feedback seems unclear or technically questionable.
---

# Receiving Code Review — technical rigor over performance

Paired with `requesting-code-review` (the reviewer side). This is the implementer side: how to react to findings from an automated reviewer, a human PR reviewer, a book editor, a design critic, or any other source — without two failure modes.

**Failure mode A: blind agreement.** "You're absolutely right!" then implement. The finding was never verified. Half the time the reviewer was wrong, the cited line moved, or the suggested fix breaks an invariant they did not know about. You now own a regression.

**Failure mode B: performative pushback.** "I disagree, this is fine." No technical specifics, no citation, no evidence. Reviewer pushes back harder. You either cave (back to A) or dig in (the regression ships anyway).

**Core principle:** Verify before implementing. Ask before assuming. Technical correctness over social comfort.

The rule: every finding gets ONE of three legitimate replies, and each reply has an evidence bar.

---

## 1. Three legitimate replies to a finding

Pick ONE per finding. Never "I'll think about it" — that is silent deferral and rots the review thread.

- **Agree-and-fix** — reproduce the finding, accept it, change the code, link the commit.
- **Disagree-with-reason** — cite the file, the line, the contract, the test, or the invariant that makes the finding wrong. No vibes.
- **Need-more-info** — ask ONE specific question. Not "can you explain?" Instead: "you flagged L42 as a null deref — is the concern the early-return path on L38 or the catch block on L51?"

If you cannot pick one within 60 seconds of reading the finding, you have not understood it yet. Re-read it twice before replying.

---

## 2. Handling unclear feedback — clarify everything first

```
IF any item in multi-item feedback is unclear:
  STOP - do not implement anything yet
  ASK for clarification on the unclear items

WHY: Items may be related. Partial understanding = wrong implementation.
```

**Example:**

```
The user: "Fix items 1-6"
You understand 1,2,3,6. Unclear on 4,5.

WRONG: Implement 1,2,3,6 now, ask about 4,5 later
RIGHT: "I understand items 1,2,3,6. Need clarification on 4 and 5 before proceeding."
```

---

## 3. Before agreeing — verify the finding is real

Reproduce it. Open the cited file at the cited line. Run the failing command, the failing test, the failing query. If the bug does not reproduce, that is a Disagree-with-reason.

A finding you cannot reproduce is a finding you cannot fix. "Agreeing" without reproduction means you will guess at a fix, the guess will be wrong, and the next reviewer round will flag it again.

If you cannot easily verify, say so: "I can't verify this without [X]. Should I investigate, ask, or proceed?"

---

## 4. Before disagreeing — read twice and look up what you do not know

Reviewers cite domain knowledge, codebase invariants, security contracts, or framework rules you may not have loaded. Before pushing back:

- Read the finding twice. The second read often surfaces what the first missed.
- If the finding cites a contract, file, or rule you do not recognise, look it up. `grep`, `git log -S`, read the linked doc.
- Only then push back — with technical specifics. Quote the line. Cite the test. Reference the contract.

"I disagree" alone is performative. "I disagree because L88 already handles this branch — see test_null_email at L201" is technical.

---

## 5. Technical-rigor red flags — stop, verify, then reply

These reply patterns are the ones that ship regressions. When you catch yourself writing one, stop and verify before sending.

- **"This is fine because the existing code does it too."** Verify the existing code is actually correct first. "Two wrongs" is not a refutation; it is a second bug you just inherited.
- **"I tested it and it works."** Show the test output. If you did not actually run it, run it now and paste the output. "It works on my machine" without evidence is not evidence.
- **"The reviewer is wrong about X."** Quote the specific line, name the specific contract, link the specific test. Vague disagreement is performative pushback.
- **"I'll address this later."** Either do it now or open a tracked issue AND link the tracker in your reply. "Later" with no link is silent deferral.
- **"That is out of scope."** Maybe true — but if the finding is blocking severity, scope is the wrong axis. Either fix it now or downgrade the change.

---

## 6. Forbidden responses — the phrase ban

**NEVER:**

- "You're absolutely right!"
- "Great point!" / "Excellent feedback!"
- "Thanks for catching that!" / "Thanks for [anything]" — ANY gratitude expression
- "Let me implement that now" (before verification)

**INSTEAD:**

- Restate the technical requirement
- Ask a clarifying question
- Push back with technical reasoning if wrong
- Just fix it and show the change: "Fixed. [Brief description of what changed]" or "Good catch — [specific issue]. Fixed in [location]."

**Why no thanks:** Actions speak. The code itself shows you heard the feedback. If you catch yourself about to write "Thanks" — delete it and state the fix instead.

---

## 7. Severity calibration — match reply rigor to finding severity

Whatever severity vocabulary the reviewer uses (blocking / warning / nit, or critical / high / medium / low):

- **Blocking / critical** — ALWAYS agree-and-fix OR a fully-cited disagree with reproducible evidence. Never defer. Never nit-batch. Never "out of scope."
- **Warning / medium** — agree-and-fix OR explicit defer-with-tracking (issue link required). A warning you accept without tracking is one you will forget.
- **Nit / suggestion** — batch-resolve in one commit OR explicit won't-fix-because. Reviewers earn the right to ignore your nits after you ignore three of theirs without reason; do not burn that bank.

Mis-calibration in either direction is the bug. Treating a blocker as a nit ships regressions; treating a nit as a blocker burns trust and slows the cycle.

---

## 8. Implementation order

```
FOR multi-item feedback:
  1. Clarify anything unclear FIRST (see section 2)
  2. Then implement in this order:
     - Blocking issues (breakage, security)
     - Simple fixes (typos, imports)
     - Complex fixes (refactoring, logic)
  3. Test each fix individually
  4. Verify no regressions
```

Never batch multiple fixes into one untested change — a regression in the batch means re-bisecting the whole review round.

---

## 9. When the reviewer is wrong — push back specifically

Reviewers are wrong sometimes. Automated reviewers are wrong sometimes. Even careful human reviewers miss invariants. Pushing back is legitimate — when you have evidence.

A specific pushback contains: the file, the line, the cited behavior or contract, and the test or invocation that proves it. Example: "L42 is not a null deref — `validateInput` at L38 throws before L42 can run. See test_null_input_throws at tests/input.test.ts:14."

A non-specific pushback contains: "I disagree." "This is intentional." "That's how it works." These are vibes. Vibes lose review threads.

Also push back when the suggestion violates YAGNI: if a reviewer says "implement this properly," grep for actual usage first. If nothing calls it, the right reply is "Nothing calls this endpoint. Remove it instead?" If the suggestion conflicts with an architectural decision the user already made, stop and discuss with the user first.

---

## 10. Gracefully correcting your pushback

If you pushed back and were wrong:

```
RIGHT: "You were right - I checked [X] and it does [Y]. Implementing now."
RIGHT: "Verified this and you're correct. My initial understanding was wrong because [reason]. Fixing."

WRONG: Long apology
WRONG: Defending why you pushed back
WRONG: Over-explaining
```

State the correction factually and move on.

---

## 11. Tracking reviewer patterns

When you Disagree-with-reason on a finding from the same reviewer for the third time on the same kind of issue (same false-positive pattern), record it in your project notes: "Reviewer X tends to flag [pattern] as [severity]; in this codebase that pattern is correct because [reason]. Future findings from X on [pattern] get a quick verify-then-disagree, not full re-investigation."

Do NOT use this to silence a reviewer wholesale — only to skip re-investigating a known false-positive pattern. If a reviewer's hit rate climbs (their flagged issues turn out real on repeat), record the inverse and treat their findings as blocking on receipt, verify second.

---

## 12. Multi-domain — the reply discipline travels

The same three-reply structure works wherever feedback arrives.

- **Code review.** File + line + claim + fix.
- **Book editor's notes.** Chapter + paragraph + claim + revision.
- **Campaign copy critique.** Asset + line + claim + rewrite.
- **Design / UI critique.** Component + property + claim + change.

In every domain: cite the artifact location, restate the claim in your own words, reply with one of the three legitimate replies, and meet the evidence bar for the reply you picked.

---

## Done When

- [ ] Every finding in the review thread has exactly one reply: agree-and-fix, disagree-with-reason, or need-more-info. No silent skips.
- [ ] Every Disagree-with-reason cites file + line + contract or test. No vibes.
- [ ] Every defer has a tracker link (issue, ticket, follow-up PR). No "later."
- [ ] Unclear items were clarified BEFORE anything was implemented. No partial implementation.
- [ ] Fixes landed in order (blocking → simple → complex), each tested individually, no regressions.
- [ ] Zero performative phrases in the thread — no "You're absolutely right", no gratitude filler.

## The Bottom Line

**External feedback = suggestions to evaluate, not orders to follow.**

Verify. Question. Then implement. No performative agreement. Technical rigor always.
