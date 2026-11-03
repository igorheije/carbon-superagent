import type { StageId } from "./types";

export interface StageMeta {
  readonly label: string;
  readonly agent: string;
  readonly caption: string;
  /** One sentence on what this agent does, shown in the expanded pipeline. */
  readonly description: string;
}

export const STAGE_META: Readonly<Record<StageId, StageMeta>> = {
  intake: { label: "Intake", agent: "triage", caption: "gate + assessment", description: "Valida a tarefa, prepara o worktree isolado, instala as skills da persona e escolhe modelo e esforço." },
  plan: { label: "Plan", agent: "planner", caption: "passos + aceite", description: "Quebra a tarefa em passos verificáveis com critérios de aceite antes de tocar no código." },
  research: { label: "Research", agent: "researcher", caption: "RAG + lições", description: "Lê os arquivos mais relevantes da base de conhecimento e aplica as lições promovidas do projeto." },
  code: { label: "Code", agent: "coder", caption: "worktree isolado", description: "Implementa a mudança no branch da tarefa, sem tocar no seu branch de trabalho." },
  test: { label: "Test", agent: "tester", caption: "TDD + cobertura", description: "Escreve e roda testes para o comportamento novo e confere regressões." },
  review: { label: "Review", agent: "reviewer", caption: "quality + security", description: "Revisa qualidade e segurança e registra achados por severidade, resolvendo os que bloqueiam." },
  deliver: { label: "Deliver", agent: "delivery", caption: "PR + Linear", description: "Coleta o diff, faz o commit e, se o push estiver ligado, abre o PR e comenta no Linear." },
  reflect: { label: "Reflect", agent: "learner", caption: "lições candidatas", description: "Propõe lições reutilizáveis para o projeto. Você promove as boas e elas entram nos próximos prompts." },
};
