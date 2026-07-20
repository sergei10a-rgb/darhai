---
name: research-ops
description: |
  An evidence-first current-state research router: normalize what the user already supplied, classify the ask, take the lightest useful evidence path (quick search vs multi-source synthesis vs recommendation), and report with explicit evidence boundaries (sourced fact / user-supplied / inference / recommendation).
  Use when the user wants fresh facts, comparisons, enrichment, or a recommendation built from current public evidence.
  Do NOT use a heavy research pass when the answer already lives in local code or docs, and do NOT give freshness-sensitive answers without dates.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "research web-search evidence enrichment comparison"
  category: "data-analysis"
  subcategory: "research"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Research Ops

Use this when the user asks to research something current, compare options, enrich people or companies, or turn repeated lookups into a monitored workflow.

This is the operator wrapper around a research stack. It is not a replacement for a deep-research or web-search capability; it tells you when and how to use them together.

## Companion Capabilities

Pull these into the workflow when relevant:

- A fast web-search capability for current-web discovery
- A multi-source deep-research capability for synthesis with citations
- A market-research capability when the end result should be a recommendation or ranked decision
- A lead/enrichment capability when the task is people/company targeting instead of generic research
- A durable-context capability when the result should be stored for later

## When to Use

- user says "research", "look up", "compare", "who should I talk to", or "what's the latest"
- the answer depends on current public information
- the user already supplied evidence and wants it factored into a fresh recommendation
- the task may be recurring enough that it should become a monitor instead of a one-off lookup

## Guardrails

- do not answer current questions from stale memory when fresh search is cheap
- separate:
  - sourced fact
  - user-provided evidence
  - inference
  - recommendation
- do not spin up a heavyweight research pass if the answer is already in local code or docs

## Workflow

### 1. Start from what the user already gave you

Normalize any supplied material into:

- already-evidenced facts
- needs verification
- open questions

Do not restart the analysis from zero if the user already built part of the model.

### 2. Classify the ask

Choose the right lane before searching:

- quick factual answer
- comparison or decision memo
- lead/enrichment pass
- recurring monitoring candidate

### 3. Take the lightest useful evidence path first

- use a fast web-search capability for quick discovery
- escalate to a deep-research capability when synthesis or multiple sources matter
- use a market-research capability when the outcome should end in a recommendation
- hand off to a lead/enrichment capability when the real ask is target ranking or warm-path discovery

### 4. Report with explicit evidence boundaries

For important claims, say whether they are:

- sourced facts
- user-supplied context
- inference
- recommendation

Freshness-sensitive answers should include concrete dates.

### 5. Decide whether the task should stay manual

If the user is likely to ask the same research question repeatedly, say so explicitly and recommend a monitoring or workflow layer instead of repeating the same manual search forever.

## Output Format

```text
QUESTION TYPE
- factual / comparison / enrichment / monitoring

EVIDENCE
- sourced facts
- user-provided context

INFERENCE
- what follows from the evidence

RECOMMENDATION
- answer or next move
- whether this should become a monitor
```

## Pitfalls

- do not mix inference into sourced facts without labeling it
- do not ignore user-provided evidence
- do not use a heavy research lane for a question local repo context can answer
- do not give freshness-sensitive answers without dates

## Verification

- important claims are labeled by evidence type
- freshness-sensitive outputs include dates
- the final recommendation matches the actual research mode used
