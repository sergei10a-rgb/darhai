# mn.6 Assimilation — working documents

Master goal (serge, 2026-07-20): merge EVERYTHING into one Darhai monolith at the
code level, until no seam is visible — "хуулахыг нь хуулаад, засахыг нь засаад,
санааг нь орхигдуулахгүй шинээр бичих бол бичээд, бүгдийг Дархайн нэг цул болгох".

Sources being assimilated:

| Source | What | Method |
| --- | --- | --- |
| ECC (vendored, `resources/bundled-ecc`) | 271 skills, 114 rules, 92 commands, 67 agents, hooks | skills/rules/commands/agents: convert & copy into Darhai sanctums; hooks: REWRITE natively as an app-level guard at the tool-approval boundary (works for every engine: wcore, local models, CLIs) |
| Superpowers 14 skills | process skills (TDD, debugging, plans, review…) | best-of merge per `superpowers-dedup-verdicts.json` (see below) |
| IJFW | memory server + UI | absorb server as in-app module; kill external `~/.ijfw` install; migrate existing data |
| Odysseus (`C:\claude\Odysseus`, Python) | 9 features (see task #27): cookbook-serve, memory auto-extraction, deep research, notes+tasks+scheduler, documents editor, compare, email triage, calendar+CalDAV, web search | ideas only — rewrite natively in Darhai TypeScript (precedent: hwfit + hybrid retrieval, commits `8c3cb0e5b` / `d2e47f849`) |

Ground rules (binding):

1. Nothing dropped silently — every source item gets a ledger entry:
   converted / rewritten / dropped+reason.
2. No guessing — every design decision cites file-level evidence
   (see `../codemap/` produced by the mapping phase).
3. One concept = one skill. Duplicates are merged best-of, never shipped side by side.
4. User-visible naming is Darhai-branded; third-party names disappear from the UI.
5. Sequence: codemap → charter → workstreams (superpowers merge, ECC layers,
   IJFW absorption, Odysseus features). mn.5 release ships before mn.6 lands.

## superpowers-dedup-verdicts.json

Head-to-head evaluation (14 evaluator agents, 2026-07-20) of each Superpowers
skill vs its functional duplicates across ECC / Darhai builtin / skills-library /
IJFW pools. Result: 13 verdicts + 1 no-counterpart (`using-git-worktrees`).
Score: 12/14 superpowers-base (4 as-is wins, 8 merge with grafts), 2 existing-base
(receiving-code-review ← IJFW leaner base; writing-skills ← Darhai skill-creator base).
Each verdict carries a concrete `merge_plan` naming exact sections to graft and
what to strip (engine-bound machinery: IJFW MCP/state deps, ECC slash-command deps,
tmux/devfleet tooling). Key environment fact from the match phase `notes`:
IJFW skills do NOT ship to end users (dev-machine only, `C:\Users\serge\.ijfw\claude`),
so user-facing dedup pressure is against ECC + builtin + library pools only.
