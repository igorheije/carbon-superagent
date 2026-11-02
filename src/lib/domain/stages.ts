import type { StageId } from "./types";

export interface StageMeta {
  readonly label: string;
  readonly agent: string;
  readonly caption: string;
}

export const STAGE_META: Readonly<Record<StageId, StageMeta>> = {
  intake: { label: "Intake", agent: "triage", caption: "gate + assessment" },
  plan: { label: "Plan", agent: "planner", caption: "passos + aceite" },
  research: { label: "Research", agent: "researcher", caption: "RAG + lições" },
  code: { label: "Code", agent: "coder", caption: "worktree isolado" },
  test: { label: "Test", agent: "tester", caption: "TDD + cobertura" },
  review: { label: "Review", agent: "reviewer", caption: "quality + security" },
  deliver: { label: "Deliver", agent: "delivery", caption: "PR + Linear" },
  reflect: { label: "Reflect", agent: "learner", caption: "lições candidatas" },
};
