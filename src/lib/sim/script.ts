import type {
  DiffFile,
  LogLevel,
  ReviewFinding,
  RetrievalHit,
  StageId,
} from "@/lib/domain/types";

/** One scripted event the simulator replays for a ticket, one per tick. */
export type ScriptEvent =
  | { readonly kind: "stage"; readonly stage: StageId }
  | { readonly kind: "log"; readonly stage: StageId; readonly level: LogLevel; readonly text: string }
  | { readonly kind: "plan"; readonly steps: readonly string[] }
  | { readonly kind: "check"; readonly stepIndex: number }
  | { readonly kind: "hit"; readonly hit: RetrievalHit }
  | { readonly kind: "diff"; readonly file: DiffFile }
  | { readonly kind: "tests"; readonly added: number; readonly passing: number; readonly total: number }
  | { readonly kind: "finding"; readonly finding: ReviewFinding }
  | { readonly kind: "resolve"; readonly findingIndex: number }
  | { readonly kind: "pr"; readonly number: number; readonly branch: string }
  | { readonly kind: "lesson"; readonly rule: string; readonly evidence: string; readonly scope: string; readonly confidence: number }
  | { readonly kind: "tokens"; readonly amount: number };

export interface TicketSpec {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly source: "linear" | "github";
  readonly repo: string;
  readonly requester: string;
  readonly priority: "urgent" | "high" | "medium" | "low";
  readonly plan: readonly string[];
  readonly hits: readonly RetrievalHit[];
  readonly files: readonly DiffFile[];
  readonly tests: { readonly added: number; readonly total: number; readonly flakyFirstRun: boolean };
  readonly findings: readonly Omit<ReviewFinding, "resolved">[];
  readonly prNumber: number;
  readonly lesson: { readonly rule: string; readonly evidence: string; readonly scope: string; readonly confidence: number };
}

const log = (stage: StageId, level: LogLevel, text: string): ScriptEvent => ({
  kind: "log",
  stage,
  level,
  text,
});

function intake(spec: TicketSpec): ScriptEvent[] {
  return [
    { kind: "stage", stage: "intake" },
    log("intake", "info", `trigger ${spec.source}:${spec.key} de @${spec.requester}`),
    log("intake", "tool", "policy.gate → allowlist ok · menção ao agente ok"),
    log("intake", "think", "assessment: escopo local, sem decisão de design pendente"),
    log("intake", "ok", "eval: accept · mandate emitido"),
    { kind: "tokens", amount: 1800 },
  ];
}

function plan(spec: TicketSpec): ScriptEvent[] {
  return [
    { kind: "stage", stage: "plan" },
    log("plan", "think", "decompondo tarefa em passos verificáveis…"),
    { kind: "plan", steps: spec.plan },
    log("plan", "ok", `plano com ${spec.plan.length} passos e critérios de aceite`),
    { kind: "tokens", amount: 4200 },
  ];
}

function research(spec: TicketSpec): ScriptEvent[] {
  const hits = spec.hits.map((hit): ScriptEvent => ({ kind: "hit", hit }));
  return [
    { kind: "stage", stage: "research" },
    log("research", "tool", "rag.search(hybrid: bm25 + pgvector, k=8, rerank)"),
    ...hits,
    log("research", "ok", `${spec.hits.length} trechos relevantes · 1 lição aplicada`),
    { kind: "check", stepIndex: 0 },
    { kind: "tokens", amount: 6100 },
  ];
}

function code(spec: TicketSpec): ScriptEvent[] {
  const files = spec.files.flatMap((file): ScriptEvent[] => [
    log("code", "tool", `edit ${file.path}`),
    { kind: "diff", file },
  ]);
  return [
    { kind: "stage", stage: "code" },
    log("code", "tool", `sandbox: git worktree add agent/${spec.key.toLowerCase()}`),
    ...files,
    { kind: "check", stepIndex: 1 },
    log("code", "ok", `${spec.files.length} arquivos alterados`),
    { kind: "tokens", amount: 14800 },
  ];
}

function test(spec: TicketSpec): ScriptEvent[] {
  const { added, total, flakyFirstRun } = spec.tests;
  const firstRun: ScriptEvent[] = flakyFirstRun
    ? [
        { kind: "tests", added, passing: total - 1, total },
        log("test", "warn", "1 teste falhou: expected 429, received 200"),
        log("test", "think", "causa: janela do limiter não reinicia entre testes → isolar store"),
        log("test", "tool", "edit tests/setup.ts"),
      ]
    : [];
  return [
    { kind: "stage", stage: "test" },
    log("test", "tool", `escrevendo ${added} testes (AAA) antes de rodar a suíte`),
    log("test", "tool", "npm test -- --coverage"),
    ...firstRun,
    { kind: "tests", added, passing: total, total },
    { kind: "check", stepIndex: 2 },
    log("test", "ok", `${total}/${total} verdes · cobertura 87%`),
    { kind: "tokens", amount: 7300 },
  ];
}

function review(spec: TicketSpec): ScriptEvent[] {
  const found = spec.findings.map(
    (finding): ScriptEvent => ({ kind: "finding", finding: { ...finding, resolved: false } }),
  );
  const resolved = spec.findings.flatMap((finding, index): ScriptEvent[] =>
    finding.severity === "CRITICAL" || finding.severity === "HIGH"
      ? [log("review", "tool", `corrigindo: ${finding.text}`), { kind: "resolve", findingIndex: index }]
      : [],
  );
  return [
    { kind: "stage", stage: "review" },
    log("review", "tool", "code-reviewer + security-reviewer em paralelo"),
    ...found,
    ...resolved,
    { kind: "check", stepIndex: 3 },
    log("review", "ok", "sem CRITICAL/HIGH abertos"),
    { kind: "tokens", amount: 5200 },
  ];
}

function deliver(spec: TicketSpec): ScriptEvent[] {
  const branch = `agent/${spec.key.toLowerCase()}`;
  return [
    { kind: "stage", stage: "deliver" },
    log("deliver", "tool", `outbox: gh pr create --base main --head ${branch}`),
    { kind: "pr", number: spec.prNumber, branch },
    log("deliver", "tool", `outbox: linear.comment(${spec.key}) + status → In Review`),
    { kind: "check", stepIndex: 4 },
    log("deliver", "ok", `PR #${spec.prNumber} pronto para revisão humana`),
    { kind: "tokens", amount: 1400 },
  ];
}

function reflect(spec: TicketSpec): ScriptEvent[] {
  return [
    { kind: "stage", stage: "reflect" },
    log("reflect", "think", "comparando plano × execução × sinais de teste/review"),
    { kind: "lesson", ...spec.lesson },
    log("reflect", "ok", "lição candidata aguardando promoção humana"),
    { kind: "tokens", amount: 2100 },
  ];
}

/** Expands a ticket spec into the ordered event script the engine replays. */
export function buildScript(spec: TicketSpec): readonly ScriptEvent[] {
  return [
    ...intake(spec),
    ...plan(spec),
    ...research(spec),
    ...code(spec),
    ...test(spec),
    ...review(spec),
    ...deliver(spec),
    ...reflect(spec),
  ];
}
