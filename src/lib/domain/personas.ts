/** Personas shape the agent's framing, deliverable and default skills per user type. */
export const PERSONA_IDS = ["engineering", "product", "design", "qa", "data"] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];

export interface Persona {
  readonly id: PersonaId;
  readonly label: string;
  readonly tagline: string;
  readonly deliverable: string;
  readonly framing: string;
  readonly defaultSkills: readonly string[];
}

export const PERSONAS: Readonly<Record<PersonaId, Persona>> = {
  engineering: {
    id: "engineering",
    label: "Engenharia",
    tagline: "Código, testes e PR revisável.",
    deliverable: "mudança de código com testes",
    framing:
      "You are working for a software engineer. Deliver production-quality code with tests, following the repository's conventions.",
    defaultSkills: ["carbon-pr-description", "carbon-test-plan"],
  },
  product: {
    id: "product",
    label: "Produto",
    tagline: "Specs, critérios de aceite e PRDs no repo.",
    deliverable: "documento de produto em docs/",
    framing:
      "You are working for a product manager. Prefer writing or updating specs, acceptance criteria and PRDs under docs/. Only change code when the task explicitly asks for it.",
    defaultSkills: ["carbon-product-spec", "carbon-pr-description"],
  },
  design: {
    id: "design",
    label: "Design",
    tagline: "UI, tokens e revisão de acessibilidade.",
    deliverable: "ajuste de interface com checagem de a11y",
    framing:
      "You are working for a product designer. Focus on UI, design tokens, copy and accessibility (WCAG 2.2 AA). Keep changes visual and scoped.",
    defaultSkills: ["carbon-design-review", "carbon-pr-description"],
  },
  qa: {
    id: "qa",
    label: "QA",
    tagline: "Planos de teste e testes automatizados.",
    deliverable: "testes automatizados e plano de teste",
    framing:
      "You are working for a QA engineer. Reproduce issues, write automated tests and document test plans. Do not change production behavior unless asked.",
    defaultSkills: ["carbon-test-plan", "carbon-pr-description"],
  },
  data: {
    id: "data",
    label: "Dados",
    tagline: "Queries, modelos e análises versionadas.",
    deliverable: "query/modelo de dados revisável",
    framing:
      "You are working for a data professional. Write safe, reviewable SQL/data code. Never run destructive statements and never print personal data.",
    defaultSkills: ["carbon-pr-description"],
  },
};

export function isPersonaId(value: string): value is PersonaId {
  return (PERSONA_IDS as readonly string[]).includes(value);
}
