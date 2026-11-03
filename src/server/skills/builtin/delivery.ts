import type { BuiltinSkill } from "./types";

/** Interfaces, end-to-end flows and the QA and data personas. */
export const DELIVERY_SKILLS: readonly BuiltinSkill[] = [
  {
    name: "carbon-frontend-quality",
    description: "Use when changing UI code (React, Vue, React Native, HTML/CSS): ship complete states, accessibility and responsive behavior, not just the happy path.",
    personas: ["engineering", "design"],
    body: `# Frontend quality

- States: every data-driven view has loading, empty, error and success states; errors offer a way out (retry, back).
- Reuse the design system: existing components and tokens; no new hardcoded colors, spacing or fonts.
- Accessibility (WCAG 2.2 AA): semantic elements, labels on inputs, alt text, visible focus, keyboard reachable, contrast 4.5:1 (3:1 for large text), no information by color alone.
- Motion: animate transform/opacity only; respect prefers-reduced-motion.
- Responsive: check 390px and 1440px; no horizontal scroll; touch targets at least 44px on mobile.
- Performance: avoid re-render storms (stable keys, no inline objects into memoized children when it matters), lazy-load heavy parts, set image dimensions.
- Copy: in the product's language, short, consistent with existing screens.

Add or update component/E2E tests for the main interaction. Report accessibility gaps you could not fix as CARBON_FINDING.`,
  },
  {
    name: "carbon-e2e-critical-flow",
    description: "Use when a change touches a critical user flow (login, checkout, booking, onboarding): cover it with a deterministic end-to-end test.",
    personas: ["engineering", "qa"],
    body: `# End-to-end test for a critical flow

- Use the E2E tool the repo already has (Playwright, Cypress, Detox, Maestro). If none exists, ask before adding one (CARBON_QUESTION with options).
- One test per user goal, written as the user would do it: given / when / then.
- Selectors: roles, labels or data-testid — never CSS classes or text that changes often.
- Deterministic waits only (wait for a response, element or URL). No sleep/timeouts as synchronization.
- Isolated data: each test creates what it needs and does not depend on test order.
- Mock only third parties you do not control (payments, SMS); hit your own API for real.
- On failure keep artifacts (screenshot, trace) where the project's config stores them.

Run the test at least twice to catch flakiness and report CARBON_TESTS.`,
  },
  {
    name: "carbon-qa-acceptance",
    description: "Use for QA tasks: turn acceptance criteria into tests and an exploratory checklist, and report bugs in a reproducible format.",
    personas: ["qa"],
    body: `# QA acceptance

1. Map: list each acceptance criterion (Dado / quando / então). Missing or vague criteria become a CARBON_QUESTION with proposed criteria as options.
2. Automate: one test per criterion at the lowest level that proves it (unit < integration < E2E).
3. Explore: edge cases the criteria forgot — empty, max length, special characters, slow network, double submit, back button, permissions, time zones.
4. Report each bug as CARBON_FINDING with: esperado, atual, passos para reproduzir, ambiente, evidência, impacto.
5. Summary: a coverage table criterion → test → status.

Do not change product code unless the task asks for fixes.`,
  },
  {
    name: "carbon-data-analysis",
    description: "Use for data tasks (queries, reports, metrics, notebooks): make the analysis reproducible and never invent numbers.",
    personas: ["data"],
    body: `# Data analysis

- Reproducible: queries and scripts live in the repo (sql/, notebooks/, scripts/) with parameters, not pasted results.
- State assumptions: time window, time zone, filters, how duplicates and nulls are treated, what counts as an active user/event.
- Validate: row counts before/after joins, sums that should match a known total, sample rows that look right.
- Never invent or extrapolate numbers that were not computed; if data is missing, say what is missing.
- Performance: filter early, avoid SELECT * on large tables, use LIMIT while exploring.
- Privacy: aggregate; never export personal data in results, examples or logs (see carbon-lgpd-data-guard).

Summary: the question, the method, the result with its caveats, and how to rerun it.`,
  },
];
