# Isolation Techniques

Techniques for narrowing a bug down to its exact location when the search space is large: binary search across code, history, and data; disciplined stack trace reading; and strategies for intermittent bugs. Use these during Phase 1 (root cause investigation) and Phase 3 (hypothesis testing) of systematic debugging.

## Binary Search Debugging

When the bug is somewhere in a large codebase or a long sequence of operations, use binary search to narrow it down.

### In Code

1. Identify the start (known-good state) and end (known-bad state).
2. Insert a check/log at the midpoint.
3. If the midpoint is good, the bug is in the second half.
4. If the midpoint is bad, the bug is in the first half.
5. Repeat until you isolate the exact line.

### In Time (git bisect)

```shell
git bisect start
git bisect bad              # current commit is broken
git bisect good abc1234     # this older commit was working
# Git checks out the midpoint. Test it.
git bisect good             # or git bisect bad
# Repeat until the first bad commit is identified.
git bisect reset            # return to original HEAD
```

### In Data

1. Take the input that causes the bug.
2. Split it in half.
3. Test each half independently.
4. The half that triggers the bug contains the problematic data.
5. Repeat until you find the minimal failing input.

The same halving works on test suites: to find which test pollutes shared state, run half the suite, check for the pollution artifact, and recurse into the failing half.

## Stack Trace Reading

### Anatomy of a Stack Trace

Read from bottom to top (most languages). The bottom frame is where the exception originated. The top frame is the entry point.

```
Exception in thread "main" java.lang.NullPointerException
    at com.app.service.OrderService.calculateTotal(OrderService.java:45)    <-- CAUSE
    at com.app.controller.OrderController.submit(OrderController.java:112)
    at com.app.filter.AuthFilter.doFilter(AuthFilter.java:30)
    at org.springframework.web.servlet.DispatcherServlet.service(...)       <-- FRAMEWORK
```

**Rules:**

1. Start at the first frame that is YOUR code (skip framework frames).
2. Read the exception message carefully; it often tells you the exact variable that is null/missing.
3. Note the line number and open that exact line.
4. Check what is on that line that could produce the stated exception.

### Multi-Cause Stack Traces (Caused by)

```
Exception: Failed to process order
    at OrderService.process(OrderService.java:50)
Caused by: java.sql.SQLException: Connection refused
    at com.mysql.jdbc.Driver.connect(Driver.java:200)        <-- ROOT CAUSE
```

Always read the deepest "Caused by" first. That is the root cause.

### Async/Promise Stack Traces

Async stack traces are often incomplete. Use these strategies:

- Enable long stack traces in Node.js: `--async-stack-traces`
- In Python, use the `traceback` module with `__cause__`
- In JavaScript, use `Error.captureStackTrace` or named async functions

## Intermittent Bug Strategies

For bugs that do not reproduce consistently:

1. **Increase logging** at the suspected failure point.
2. **Add assertions** that crash loudly if invariants are violated.
3. **Stress test** with high concurrency / volume to increase reproduction rate.
4. **Check for timing dependencies**: race conditions, timeouts, cache expiry (see `condition-based-waiting.md` for the fix pattern in tests).
5. **Check for state dependencies**: order of operations, prior requests, accumulated data.
6. **Check for environment dependencies**: timezone, locale, disk space, DNS resolution.
7. **Inject failures systematically** (fault injection / chaos tooling) when the failure only appears under partial outages.

If the bug cannot be reproduced at all:

- Verify your environment matches the reporter's (OS, runtime version, config, data state).
- Check for data-dependent behavior — request the exact failing input if possible.
- Review recent deployments and dependency updates.
- Check for client-specific factors (browser, OS, locale).
- If it remains unreproducible, improve observability (logging, assertions, monitoring) and wait for the next occurrence with better evidence — don't guess-fix.
