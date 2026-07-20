---
name: aside
description: >-
  Answers a quick side question mid-task without disturbing the active work, then resumes exactly where it left off.
  Use when the user pauses to ask about code, an error, a concept, or a decision while a larger task is in progress.
  Do NOT use when the user is redirecting the task itself or starting genuinely new work.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "context-management focus question-answering workflow productivity"
  category: "productivity"
  subcategory: "focus"
  depends: ""
  disclaimer: "none"
  difficulty: "beginner"
---

# Aside

Answer a side question that the user raises in the middle of an active task, then continue right where you left off. The current task, files, and context are never modified while answering.

## When to Use

- The user is curious about something while you are working and does not want to lose momentum
- The user needs a quick explanation of code you are currently editing
- The user wants a second opinion or clarification on a decision without derailing the task
- The user needs to understand an error, concept, or pattern before you proceed
- The user asks something unrelated to the current task without wanting to start a new session

Typical side questions look like: "what does this function actually return?", "is this pattern thread-safe?", "why are we using X instead of Y here?", "should we be worried about the N+1 query we just added?"

## Process

### Step 1: Freeze the current task state

Before answering anything, mentally note:

- What is the active task? (which file, feature, or problem was being worked on)
- What step was in progress at the moment the question was asked?
- What was about to happen next?

Do NOT touch, edit, create, or delete any files while answering the aside.

### Step 2: Answer the question directly

Answer in the most concise form that is still complete and useful.

- Lead with the answer, not the reasoning.
- Keep it short. If a full explanation is needed, offer to go deeper after the task.
- If the question is about the current file or code being worked on, reference it precisely (file path and line number if relevant).
- If answering requires reading a file, read it — but read only, never write.

Format the response as:

```
ASIDE: [restate the question briefly]

[Your answer here]

— Back to task: [one-line description of what was being done]
```

### Step 3: Resume the main task

After delivering the answer, immediately continue the active task from the exact point it was paused. Do not ask for permission to resume unless the answer revealed a blocker or a reason to reconsider the current approach (see Edge Cases).

## Edge Cases

**No question actually provided:**
```
ASIDE: no question provided

What would you like to know? (ask your question and I'll answer without losing the current task context)

— Back to task: [one-line description of what was being done]
```

**The answer reveals a potential problem with the current task:**
Flag it clearly before resuming:
```
ASIDE: [answer]

WARNING: This answer suggests [issue] with the current approach. Want to address this before continuing, or proceed as planned?
```
Wait for the user's decision before resuming.

**The question is actually a task redirect (not a side question):**
If the question implies changing what is being built (e.g., "actually, let's use Redis instead"), clarify:
```
ASIDE: That sounds like a direction change, not just a side question.
Do you want to:
  (a) Answer this as information only and keep the current plan
  (b) Pause the current task and change approach
```
Wait for the user's answer — do not make assumptions.

**The question is about the currently open file or code:**
Answer from the live context. If the file was read earlier in the session, reference it directly. If not, read it now (read-only) and answer with a file:line reference.

**No active task in progress:**
Still use the standard wrapper so the response shape stays consistent:
```
ASIDE: [restate the question briefly]

[Your answer here]

— Back to task: no active task to resume
```

**The question requires a long answer:**
Give the essential answer concisely, then offer:
```
That's the short version. Want a deeper explanation after we finish [current task]?
```

**Multiple side questions in a row:**
Answer each one in sequence. After the last answer, resume the main task. Do not lose task state across a chain of asides.

**The answer implies a code change is needed:**
Note the change needed but do not make it during the aside:
```
ASIDE: [answer]

Worth fixing: [what should be changed]. I'll flag this after the current task unless you want to address it now.
```

**The question is ambiguous or too vague:**
Ask one clarifying question — the shortest question that gets the information needed to answer. Do not ask multiple questions.

## Example

```
User: what does fetchWithRetry() actually do?

ASIDE: what does fetchWithRetry() do?

fetchWithRetry() (src/api/retry.ts:12) attempts the request up to 3 times with
exponential backoff (250ms → 500ms → 1s). It only retries on 5xx responses and
network errors — 4xx errors are treated as final and not retried.

— Back to task: refactoring the auth middleware in src/middleware/auth.ts
```

## Notes

- Never modify files during an aside — read-only access only.
- The aside is a conversation pause, not a new task — the original task must always resume.
- Keep answers focused: the goal is to unblock the user quickly, not to deliver a lecture.
- If an aside sparks a larger discussion, finish the current task first unless the aside reveals a blocker.
