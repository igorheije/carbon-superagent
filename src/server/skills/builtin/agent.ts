import type { BuiltinSkill } from "./types";

/** How the agent gathers context, spends its budget, gets unstuck and decides. */
export const AGENT_SKILLS: readonly BuiltinSkill[] = [
  {
    name: "carbon-search-first",
    description: "Use before writing any new helper, module or dependency: search the repo and its existing dependencies for something that already solves it.",
    personas: [],
    body: `# Search first, build last

Before writing new code, spend one short research pass:

1. Read .carbon/PROJECT_MAP.md and the pre-selected files from the prompt.
2. Grep the repo for the concept (names, synonyms, error messages, route paths). Check utils/, lib/, shared/, common/.
3. Check package.json / pyproject / go.mod: is there already a dependency that does this?
4. Decide with this matrix and say which one you picked in your summary:

| Found | Do |
| --- | --- |
| Same thing exists in the repo | Reuse it. Do not duplicate. |
| Close thing exists | Extend it, keeping its callers working. |
| An installed dependency covers it | Use the dependency. |
| Nothing | Build it, small and local. Do not add a new dependency without the carbon-dependency-hygiene checks. |

Anti-patterns: a second date formatter, a second HTTP client wrapper, a hand-rolled validator when the project already uses zod/pydantic.`,
  },
  {
    name: "carbon-iterative-retrieval",
    description: "Use when the task touches code you have not seen yet: gather context in short, targeted rounds instead of reading the whole repo.",
    personas: [],
    body: `# Iterative retrieval

Context is a budget. Retrieve in rounds, at most three:

1. Round 1 — map: PROJECT_MAP.md, the pre-selected files, the entry point closest to the task (route, command, component).
2. Round 2 — trace: follow imports and call sites of the symbols you will change. Grep for usages before you open files.
3. Round 3 — confirm: read the tests and the one or two neighbours that share the pattern you are about to follow.

After each round write one line: what you learned and what is still unknown. Stop as soon as you can name every file you will change and how you will test it.

Rules:
- Grep and read ranges; do not open huge generated files, lockfiles or build output.
- Prefer the code over the docs when they disagree, and mention the disagreement.
- If after three rounds the target is still ambiguous, ask a CARBON_QUESTION with the candidates as CARBON_OPTION lines.`,
  },
  {
    name: "carbon-context-budget",
    description: "Use on long or broad tasks: keep the working context lean so the agent stays accurate until the end.",
    personas: [],
    body: `# Context budget

- Search before reading: grep for the symbol, then read only the matching range.
- Never cat lockfiles, minified bundles, snapshots, fixtures larger than a screen, or binary files.
- Summarise what you learned from a file in one line instead of re-reading it later.
- Batch independent reads and commands instead of one per turn.
- Run long commands with output trimmed (tail, --silent, --reporter=dot) and look for the failing part.
- At each stage change (CARBON_STAGE), drop what the next stage does not need: keep decisions, file list and open risks.
- If the task keeps growing, finish the smallest shippable slice, mark the rest with CARBON_SKIPPED and say why.`,
  },
  {
    name: "carbon-agent-self-debug",
    description: "Use when the same command, test or edit fails twice, or when you notice you are looping: capture, diagnose, recover in a contained way, or stop and ask.",
    personas: [],
    body: `# Agent self-debug

Trigger: the same failure twice, an edit that does not apply, a tool that keeps being denied, or no progress for several steps.

1. Capture: the exact command, the exact error (first relevant lines), what you expected.
2. Diagnose — pick the most likely class:
   - wrong assumption about the code (re-read the file, do not trust memory);
   - environment (missing dependency, wrong cwd, wrong Node/Python version, missing env var);
   - permission or policy denial (do not try to work around it);
   - flaky test or shared state.
3. Recover in a contained way: one change that tests the hypothesis. Never delete tests, skip hooks, loosen types or disable lint rules to get green.
4. Stop rule: after two failed recoveries, stop. Print what you tried and ask a CARBON_QUESTION with concrete CARBON_OPTION lines (e.g. "install X", "skip step N and continue", "stop here").

Report the incident in the final summary under Riscos.`,
  },
  {
    name: "carbon-decision-ledger",
    description: "Use when there are two or more reasonable ways to implement something: compare them explicitly, pick one, and record why.",
    personas: [],
    body: `# Decision ledger

When you face a real design choice (not style):

1. List 2-3 options in one line each.
2. Score them against what matters for this repo: correctness, blast radius, consistency with existing patterns, reversibility, effort.
3. Pick one. Prefer the option that matches existing patterns and is easiest to undo.
4. Record it in the final summary as: Decisão: <option> — porque <reason>; alternativa descartada: <option> — <reason>.

Only stop to ask (CARBON_QUESTION + CARBON_OPTION, recommended one marked) when the choice is hard to reverse or changes product behavior: public API shape, data model, migrations, pricing/permissions, user-visible copy. Otherwise decide and move on.`,
  },
  {
    name: "carbon-docs-sync",
    description: "Use when a change alters behavior, configuration, an API or a command: update the docs that describe it in the same task.",
    personas: [],
    body: `# Docs in sync

Before finishing, check what your change made stale and update it in the same worktree:

- README / docs/: commands, setup steps, feature descriptions you changed.
- .env.example: every new or renamed environment variable, with a safe placeholder (never a real value).
- API docs (OpenAPI/Swagger, GraphQL schema docs, docs/api*): new endpoints, fields, status codes.
- CHANGELOG: only if the repo keeps one; follow its format.
- Code comments that now lie.

Do not create new documentation files unless the task asks for them. Keep the repo's language (Portuguese or English) and tone. List the docs you touched in the final summary.`,
  },
];
