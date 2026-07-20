---
name: feature-dev
description: >-
  Guides feature development through discovery, codebase exploration, clarifying questions, architecture design,
  implementation, and quality review, emphasizing understanding existing code before writing new code.
  Use when building a non-trivial feature that spans multiple files and benefits from grounding in existing patterns.
  Do NOT use for one-line fixes or purely mechanical changes.
license: Apache-2.0
type: workflow
skills: system-design-process tdd-workflow code-review-patterns
trigger_phrases: build a feature feature development implement feature guided development architecture-first feature
metadata:
  author: darhai
  version: "1.0.0"
  tags: "feature-development architecture tdd code-review step-by-step"
  category: "software-development"
  depends: "system-design-process tdd-workflow code-review-patterns"
  disclaimer: "none"
  difficulty: "intermediate"
---

# Feature Development

A structured feature-development workflow that emphasizes understanding existing code before writing new code. Where a phase names a role (explorer, architect, reviewer), run it as a delegated subagent if the runtime provides one, or perform it inline otherwise.

## Phases

### 1. Discovery

- Read the feature request carefully.
- Identify requirements, constraints, and acceptance criteria.
- Ask clarifying questions if the request is ambiguous.

### 2. Codebase Exploration

- Analyze the relevant existing code (delegate to a code-exploration agent if available, otherwise explore inline).
- Trace execution paths and architecture layers.
- Understand integration points and conventions.

### 3. Clarifying Questions

- Present findings from the exploration.
- Ask targeted design and edge-case questions.
- Wait for the user's response before proceeding.

### 4. Architecture Design

- Design the feature (delegate to a code-architecture agent if available, otherwise design inline).
- Provide the implementation blueprint.
- Wait for approval before implementing.

### 5. Implementation

- Implement the feature following the approved design.
- Prefer test-driven development where appropriate.
- Keep commits small and focused.

### 6. Quality Review

- Review the implementation (delegate to a code-review agent if available, otherwise review inline).
- Address critical and important issues.
- Verify test coverage.

### 7. Summary

- Summarize what was built.
- List follow-up items or limitations.
- Provide testing instructions.
