import type { BuiltinSkill } from "./types";

/** Tests, verification and review: what makes the result trustworthy. */
export const QUALITY_SKILLS: readonly BuiltinSkill[] = [
  {
    name: "carbon-bugfix-regression",
    description: "Use for every bug fix: reproduce the bug with a failing test first, fix it, and keep the test as a regression guard.",
    personas: ["engineering", "qa"],
    body: `# Bug fix with a regression test

1. Reproduce: write the smallest test that fails for the reported reason. Run it and confirm it fails for that reason, not for a setup error.
2. Root cause: find why, not only where. Check the same pattern elsewhere (grep) — similar bugs often come in families.
3. Fix: the minimal change that makes the test pass. No unrelated refactors.
4. Guard: run the new test, then the related suite, then the full suite once.
5. Report: CARBON_TESTS after each run; in the summary, state the root cause in one sentence and list other places with the same pattern (fixed or not).

If you cannot reproduce it, say so, explain what you tried, and do not ship a speculative fix as if it were verified.`,
  },
  {
    name: "carbon-verification-loop",
    description: "Use before declaring a task done: run build, types, lint, tests and a diff review, and report each result honestly.",
    personas: ["engineering", "qa", "design"],
    body: `# Verification loop

Run what the repo has, in this order, stopping to fix at the first failure:

1. Build / compile (npm run build, go build ./..., cargo check, python -m compileall).
2. Types (tsc --noEmit, mypy, pyright) when configured.
3. Lint / format check with the project's own config.
4. Tests: related first, then the full suite. Print CARBON_TESTS.
5. Diff review: read your own diff end to end. Look for debug prints, commented-out code, TODOs you added, secrets, unrelated changes, files over 800 lines.

Report a short table in the summary:

| Check | Result |
| --- | --- |
| build | ok / falhou: <reason> / não existe |

Never write "ok" for a check you did not run. Pre-existing failures: say they were already failing (check with git stash or the base branch) instead of hiding them.`,
  },
  {
    name: "carbon-self-review",
    description: "Use in the review stage: review your own change like a strict senior reviewer and report findings with severity.",
    personas: ["engineering"],
    body: `# Self review

Review the full diff with these lenses and print each issue as CARBON_FINDING: <SEVERITY> | <file:line> <problem>:

- CRITICAL: security hole, data loss, secret in code, broken auth, wrong data written.
- HIGH: incorrect behavior, unhandled error path, race condition, missing test for new behavior, breaking API change.
- MEDIUM: duplication, function > 50 lines, nesting > 4, unclear naming, missing input validation at a boundary.
- LOW: style the linter does not catch.

Fix every CRITICAL and HIGH before finishing and re-print them with [resolved]. Fix MEDIUM when cheap. Do not report style preferences that contradict the repo's conventions. Be specific: file, line, why it matters, and the fix.`,
  },
  {
    name: "carbon-silent-failure-hunt",
    description: "Use when the change touches error handling, I/O, network or async code: hunt for swallowed errors and misleading fallbacks.",
    personas: ["engineering"],
    body: `# Silent failure hunt

Search your diff (and the code it calls) for:

- empty catch / except blocks, or catch that only logs and continues as if it worked;
- fallbacks that hide errors: returning [], null, 0 or a default on failure without telling the caller;
- promises not awaited, errors in callbacks that never propagate, fire-and-forget without a .catch;
- optional chaining or ?? that turns a real bug into "nothing happened";
- retries without a limit, or retries on non-idempotent operations;
- logs that drop the error object or the context needed to debug.

For each case: either propagate the error, return a typed result the caller must handle, or document why ignoring it is safe. Report remaining risks as CARBON_FINDING.`,
  },
  {
    name: "carbon-refactor-safely",
    description: "Use for refactors and dead-code cleanup: lock behavior with tests first, change in small steps, and prove nothing changed.",
    personas: ["engineering"],
    body: `# Refactor safely

1. Pin behavior: make sure tests cover what you will move. If they do not, add characterization tests first (assert current output, even if odd).
2. Small steps: rename, extract, move, inline — one at a time, tests green after each.
3. No behavior change mixed in. If you find a bug, report it as CARBON_FINDING and fix it separately (or leave it, and say so).
4. Dead code: delete only with evidence (no references found by grep, the project's unused-code tool such as knip/ts-prune/vulture, no dynamic imports or reflection by name). Public exports of a library are not dead just because the repo does not use them.
5. Keep public APIs stable; if a signature must change, update every caller in the same task.

Summary: what moved where, and the proof (tests run, references checked).`,
  },
  {
    name: "carbon-performance-loop",
    description: "Use when the task is about speed, memory or cost: measure a baseline, change one thing at a time, and keep only measured wins.",
    personas: ["engineering", "data"],
    body: `# Performance loop

1. Baseline: measure before touching anything — same input, same machine, several runs; record median and p95 (or time/memory/queries).
2. Hypothesis: name the bottleneck from evidence (profiler, query plan, N+1 count, bundle size), not intuition.
3. One change per iteration, then measure again with the same harness.
4. Promotion gate: keep a change only if it beats the baseline beyond noise and tests stay green. Revert the rest.
5. Report a table:

| Variant | Median | p95 | Notes |
| --- | --- | --- | --- |

Common wins to check first: N+1 queries, missing indexes, unbounded queries without LIMIT/pagination, repeated work in loops, missing memoization of pure expensive calls, oversized payloads. Never trade correctness or security for speed.`,
  },
];
