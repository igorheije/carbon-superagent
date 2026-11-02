import type { PersonaId } from "@/lib/domain/personas";
import type { SkillInput } from "./parse";

export interface BuiltinSkill extends SkillInput {
  readonly personas: readonly PersonaId[];
}

/** Seeded on first boot. Names use the carbon- prefix so they never clash with repo skills. */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  {
    name: "carbon-pr-description",
    description: "Use when finishing a task: writes the final summary that becomes the pull request description.",
    personas: [],
    body: `# PR description

End your work with a summary in this shape (Portuguese, concise):

## O que mudou
- bullets with file-level changes

## Por quê
- link to the task and the decision behind the change

## Como testar
- exact commands or steps

## Riscos
- what could break, and what you did not verify

Never claim tests passed if you did not run them.`,
  },
  {
    name: "carbon-test-plan",
    description: "Use when changing behavior: write tests first (AAA), run them, and report results honestly.",
    personas: ["engineering", "qa"],
    body: `# Test plan

1. Find the project's test runner (package.json scripts, pytest.ini, go test).
2. Write failing tests first for the new behavior, Arrange-Act-Assert.
3. Implement until green. Run the full suite once at the end.
4. Print CARBON_TESTS: <passing>/<total> after each run.
5. If a test is flaky, isolate shared state instead of retrying.`,
  },
  {
    name: "carbon-product-spec",
    description: "Use for product tasks: write a spec or PRD under docs/ with problem, users, scope and acceptance criteria.",
    personas: ["product"],
    body: `# Product spec

Write docs/specs/<kebab-title>.md with:

- Problema (one paragraph, who feels it)
- Usuários e contexto
- Escopo / fora de escopo
- Critérios de aceite (Given/When/Then, testáveis)
- Métricas de sucesso (only if the task provides data; never invent numbers)
- Perguntas em aberto

Keep it under two pages. Do not change application code.`,
  },
  {
    name: "carbon-design-review",
    description: "Use for UI tasks: keep changes inside the design system and check accessibility before finishing.",
    personas: ["design"],
    body: `# Design review

- Reuse existing tokens/components; never hardcode new colors.
- Text contrast 4.5:1 (3:1 for 24px+), visible focus states, keyboard reachable.
- Respect prefers-reduced-motion for any animation.
- Check at 390px and 1440px widths.
- Report each accessibility issue as CARBON_FINDING with severity.`,
  },
];
