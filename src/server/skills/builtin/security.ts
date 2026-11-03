import type { BuiltinSkill } from "./types";

/** Security, personal data and supply chain. */
export const SECURITY_SKILLS: readonly BuiltinSkill[] = [
  {
    name: "carbon-security-review",
    description: "Use when the change handles auth, user input, secrets, files, external calls, payments or personal data: run the security checklist before finishing.",
    personas: ["engineering", "qa"],
    body: `# Security review

Check every item that applies to your diff; report problems as CARBON_FINDING (CRITICAL blocks delivery until resolved):

- Secrets: none hardcoded, none in logs, fixtures or test snapshots; new ones go to env vars and .env.example with placeholders.
- Input: validated at the boundary with a schema (zod, pydantic, class-validator); reject, do not "fix", bad input.
- Injection: parameterized SQL/ORM queries only; no string-built shell commands (use argument arrays); no eval.
- Authz: every new endpoint checks who the caller is and whether they may touch this record (no IDOR).
- Output: no unsanitized HTML (XSS); error messages do not leak stack traces, SQL or internal paths.
- Network: no user-controlled URLs fetched server-side without an allowlist (SSRF); timeouts on every external call.
- Files: no user-controlled paths without normalization and a base-dir check (path traversal).
- Crypto: platform libraries only, no homemade crypto, constant-time comparison for secrets and signatures.
- Webhooks: verify signatures over the raw body; reject stale timestamps.

Add at least one test for the riskiest path (e.g. unauthorized access returns 403).`,
  },
  {
    name: "carbon-lgpd-data-guard",
    description: "Use whenever code reads, stores, logs or exports personal or health data: minimize it and keep it out of logs, tests and commits.",
    personas: [],
    body: `# Personal and health data guard (LGPD)

- Minimize: collect, return and store only the fields the feature needs. Do not add fields "for later".
- Logs and errors: never log names, CPF, e-mail, phone, address, health data, tokens or full request bodies. Log ids and outcomes.
- Tests and fixtures: synthetic data only (fake names, invalid CPFs, example.com). Never copy production records.
- Exports and APIs: mask by default; expose sensitive fields only behind an explicit permission check.
- Retention: when the change stores new personal data, note in the summary how long it lives and how it is deleted.
- Never print real personal data in the agent output either.

If the task requires processing sensitive data in a way that changes who can see it, stop and ask a CARBON_QUESTION with options — this needs a human (and possibly legal/DPO) decision. This skill is guidance, not legal advice.`,
  },
  {
    name: "carbon-dependency-hygiene",
    description: "Use before adding, upgrading or removing a dependency: check necessity, health, license and lockfile impact.",
    personas: ["engineering"],
    body: `# Dependency hygiene

Before adding a package:
1. Necessity: can the standard library or an existing dependency do it (see carbon-search-first)?
2. Health: maintained recently, real adoption, no open critical advisories (npm audit / pip-audit / govulncheck when available).
3. Size and scope: avoid pulling a large framework for one function.
4. License compatible with the project (MIT/Apache/BSD are usually fine; flag GPL/AGPL/unknown).

When changing dependencies:
- Use the project's package manager and keep its lockfile consistent; never hand-edit lockfiles.
- Pin to the version range style the repo already uses.
- Upgrades: read the changelog for breaking changes, upgrade one package (or one coordinated group) at a time, run the full test suite.
- Remove dependencies only with proof they are unused.

Installing packages may need permission: request it, do not work around a denial. List every dependency change and why in the summary.`,
  },
];
