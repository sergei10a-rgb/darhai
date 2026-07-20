---
name: react-tdd
description: |
  Enforces test-driven development for React using React Testing Library plus Vitest or Jest, writing behavior-focused, accessibility-first tests before implementing components, then verifying coverage targets.
  Use when implementing a new React component or custom hook, adding coverage to an untested component, or reproducing a bug with a failing test first.
  Do NOT use for non-React code, pure end-to-end flows, or when a build is already broken (fix the build first).
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "react testing tdd react-testing-library vitest"
  category: "web-development"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# React TDD

Test-driven development for React using React Testing Library (RTL) with Vitest or Jest, detected at runtime.

## The Cycle

```
RED      -> Write a failing test for the next behavior
GREEN    -> Implement the minimal component code to pass
REFACTOR -> Improve the component; tests stay green
REPEAT   -> Next behavior
```

1. **Define the component signature** — scaffold the component, prop type, and exports.
2. **Write behavior tests first** — RTL role-first queries, `userEvent`, MSW for network. RED.
3. **Run tests** — verify they fail for the right reason.
4. **Implement minimal code** — just enough to pass. GREEN.
5. **Refactor** — improve while keeping tests green.
6. **Check coverage** — hit the coverage targets below.

## Runner Detection

```bash
test -f vitest.config.ts -o -f vitest.config.js -o -f vite.config.ts   # Vitest
grep -l '"jest"' package.json                                          # Jest
```

Prefer Vitest for new Vite-based projects; respect Jest for existing setups.

## Test Patterns

**Behavior, not implementation** — use `getByRole`, `getByLabelText`, `getByText`. Avoid `container.querySelector` and asserting on component state.

**`userEvent.setup()` per test**

```tsx
const user = userEvent.setup();
await user.click(screen.getByRole("button", { name: /save/i }));
```

**MSW for network**

```tsx
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

server.use(http.post("/api/users", () => HttpResponse.json({ id: "1" }, { status: 201 })));
```

**Custom hooks**

```tsx
const { result } = renderHook(() => useCounter(0));
act(() => result.current.increment());
expect(result.current.count).toBe(1);
```

**Accessibility**

```tsx
import { axe } from "vitest-axe";
expect(await axe(container)).toHaveNoViolations();
```

**Debounced behavior with fake timers**

```tsx
vi.useFakeTimers();
const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
const onSearch = vi.fn();
render(<SearchInput onSearch={onSearch} debounceMs={300} />);
await user.type(screen.getByRole("textbox"), "alice");
expect(onSearch).not.toHaveBeenCalled();
vi.advanceTimersByTime(300);
expect(onSearch).toHaveBeenCalledWith("alice");
vi.useRealTimers();
```

## Coverage Targets

| Layer | Target |
|---|---|
| Pure utilities | >=90% |
| Custom hooks | >=85% |
| Presentational components | >=80% |
| Container components | >=70% |
| Pages | E2E covered separately |

Configure thresholds in `vitest.config.ts` / `jest.config.js` to enforce them in CI.

## Anti-Patterns to Avoid

- `container.querySelector(...)` — bypasses accessibility queries
- Asserting on render count
- Mocking `react` itself
- Mocking child components by default (mock only when a child has heavy side effects)
- Ignoring `act()` warnings — they signal real bugs
- Snapshot tests of rendered components — brittle; use visual-diff tooling instead

## Test Commands

```bash
# Vitest
vitest                              # watch
vitest run                          # one-shot
vitest run --coverage               # with coverage
vitest run path/to/file.test.tsx    # single file

# Jest
jest --watch
jest --coverage
jest path/to/file.test.tsx

# CI mode
CI=true vitest run --coverage
```

## When to Use

- Implementing a new React component or custom hook
- Adding test coverage to an untested component
- Fixing a bug (write a failing test that reproduces it first)
- Building forms, state machines, or accessibility-critical UI

## Edge Cases

- **Mixed runner setups**: detect Vitest vs Jest before writing test imports; do not assume one.
- **Timers and async**: pair fake timers with `userEvent`'s `advanceTimers` to avoid flakiness.
- **Network-heavy components**: use MSW rather than mocking `fetch` per test.
