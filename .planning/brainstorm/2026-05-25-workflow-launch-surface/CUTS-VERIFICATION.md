# SPEC §14 Cuts Verification — W4.7

Date: 2026-05-25
Branch: `feat/workflow-launch-surface`
Scope: Verify the 5 design cuts from SPEC §14 actually landed in committed Wave 3 components. Apply minimal surgical changes only if a cut is missing.

## Result Summary

| # | Cut | File | Status |
|---|-----|------|--------|
| 1 | Drop "Save" from chrome controls | `WorkflowHeader.tsx` | VERIFIED |
| 2 | Drop checkmark from skill chips | `WorkflowHeader.tsx` | VERIFIED |
| 3 | Drop "How this works" footer | `WorkflowStepRail.tsx` | VERIFIED |
| 4 | Rename "Pause" → "Pause auto-advance" | `WorkflowHeader.tsx` | VERIFIED |
| 5 | Auto-send hidden begin on mount | `WorkflowSurface.tsx` | PARTIALLY LANDED (DEFERRED hidden-flag) |

No code changes required. All 5 cuts are present in the Wave 3 commits.

## Per-Cut Detail

### Cut 1 — Drop "Save" button — VERIFIED

`WorkflowHeader.tsx` chrome controls (lines 120–140) render exactly two `<Button>` elements: the pause toggle and `End workflow`. No `Save` string or button anywhere in the file.

Grep evidence:
```
$ grep -nE "['\"]Save['\"]|>Save<" src/renderer/pages/guid/components/workflow/WorkflowHeader.tsx
(no matches)
```

### Cut 2 — Drop checkmark from skill chips — VERIFIED

Skill chips render `{skill.display_name}` only (lines 156–163). The lone `<Check size={16} />` in the file (line 85) lives inside the `status === 'complete'` summary block — that is the completion glyph, not a skill chip.

```tsx
{session.skills.map((skill) => (
  <span key={skill.slug} className={styles.skillChip}>
    {skill.display_name}
  </span>
))}
```

### Cut 3 — Drop "How this works" footer — VERIFIED

`WorkflowStepRail.tsx` has no `How this works` string. The bottom slot (lines 265–268) is reserved for the parent-injected `<WorkflowStatusBar>`. Onboarding tooltip is a v1+ enhancement; absence of the footer is acceptable per spec.

```
$ grep -n "How this works" src/renderer/pages/guid/components/workflow/WorkflowStepRail.tsx
(no matches)
```

### Cut 4 — "Pause" → "Pause auto-advance" — VERIFIED

`WorkflowHeader.tsx:96` computes `pauseLabel = paused ? 'Resume auto-advance' : 'Pause auto-advance'` and binds it to both the button's `aria-label` and visible text (lines 126–128). The bare `'Pause'` identifier on line 9 is the lucide-react icon import; on line 97 it is the icon component (`PauseIcon = paused ? Play : Pause`). Both are non-text references.

### Cut 5 — Auto-send begin on mount — PARTIALLY LANDED (DEFERRED hidden-flag)

`WorkflowSurface.tsx` auto-sends a `begin ${workflow_name}` message via `ipcBridge.conversation.sendMessage.invoke` inside a `useEffect` gated on `launched && isFreshLaunch(data)` and guarded by `beginSentRef` (lines 166–187). Fires once after `WorkflowLaunchOverlay.onComplete`; mid-flight resume skips the send.

DEFERRED component: marking the message as hidden / system so `ChatTape` does not render it. Tracked by inline TODO (lines 166–169 + 30–35):

> `TODO(W4)`: when `ISendMessageParams` gains a hidden/internal flag, mark this message so ChatTape skips rendering it. For v1 it surfaces as a plain user message — the agent's response carries the workflow body.

Planned resolution: W8 (or whichever wave extends `ISendMessageParams`). Until then v1 ships with a visible "begin {workflow_name}" turn in the tape, which is the explicitly accepted v1 trade-off per SPEC §14 + W3.J report.

## Conclusion

All 5 cuts are accounted for. No source edits were made under W4.7. The only outstanding piece is the hidden-flag wiring for cut 5, which is a known DEFERRED item to W4/W8 and is tracked by an in-source TODO at `WorkflowSurface.tsx:166`.
