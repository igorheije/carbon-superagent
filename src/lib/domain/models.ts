/**
 * Model choice per executor. "auto" lets Carbon pick a tier from the task text;
 * explicit values are passed to the CLI as-is.
 */
export type Tier = "fast" | "balanced" | "deep";
/** Claude Code --effort accepts low…max; Codex model_reasoning_effort accepts low/medium/high. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const AUTO_MODEL = "auto";

export interface ModelOption {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

/** Claude Code accepts these aliases for the latest model of each family. */
export const CLAUDE_MODELS: readonly ModelOption[] = [
  { value: AUTO_MODEL, label: "Automático", hint: "Carbon escolhe pela tarefa" },
  { value: "haiku", label: "Haiku", hint: "rápido e barato · tarefas pequenas" },
  { value: "sonnet", label: "Sonnet", hint: "equilíbrio · maioria das tarefas" },
  { value: "opus", label: "Opus", hint: "raciocínio profundo · tarefas grandes" },
  { value: "fable", label: "Fable", hint: "modelo mais recente da Anthropic" },
];

/** Codex model names change often: "default" keeps the CLI's model; custom names are free text. */
export const CODEX_MODELS: readonly ModelOption[] = [
  { value: AUTO_MODEL, label: "Automático", hint: "modelo padrão da CLI + esforço pela tarefa" },
  { value: "default", label: "Padrão da CLI", hint: "o modelo configurado no seu Codex" },
];

export const AUTO_EFFORT = "auto";

export interface EffortOption {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

export const CLAUDE_EFFORTS: readonly EffortOption[] = [
  { value: AUTO_EFFORT, label: "Automático", hint: "Carbon escolhe pela tarefa" },
  { value: "low", label: "low", hint: "rápido, raciocina pouco" },
  { value: "medium", label: "medium", hint: "equilíbrio" },
  { value: "high", label: "high", hint: "pensa mais antes de agir" },
  { value: "xhigh", label: "xhigh", hint: "muito raciocínio · mais lento e caro" },
  { value: "max", label: "max", hint: "máximo · use em tarefas críticas" },
];

export const CODEX_EFFORTS: readonly EffortOption[] = [
  { value: AUTO_EFFORT, label: "Automático", hint: "Carbon escolhe pela tarefa" },
  { value: "low", label: "low", hint: "rápido" },
  { value: "medium", label: "medium", hint: "equilíbrio" },
  { value: "high", label: "high", hint: "pensa mais antes de agir" },
];

export function effortOptions(executor: "claude" | "codex"): readonly EffortOption[] {
  return executor === "claude" ? CLAUDE_EFFORTS : CODEX_EFFORTS;
}

/** "auto" or a level valid for that executor (Codex has no xhigh/max). */
export function isValidEffort(executor: "claude" | "codex", value: string): boolean {
  return effortOptions(executor).some((o) => o.value === value);
}

export const TIER_LABEL: Readonly<Record<Tier, string>> = { fast: "rápido", balanced: "equilíbrio", deep: "profundo" };

const CLAUDE_BY_TIER: Readonly<Record<Tier, string>> = { fast: "haiku", balanced: "sonnet", deep: "opus" };
const EFFORT_BY_TIER: Readonly<Record<Tier, Effort>> = { fast: "low", balanced: "medium", deep: "high" };

const DEEP_SIGNALS = [
  "arquitetura", "architecture", "refator", "refactor", "migra", "migration", "seguran", "security", "auth",
  "performance", "concorr", "concurrency", "race condition", "vazamento", "leak", "investigar", "investigate",
  "produção", "production", "incidente", "incident", "design system", "monorepo", "várias", "multiple",
  "end-to-end", "ponta a ponta", "pagamento", "payment", "lgpd", "criptograf", "crypto", "banco de dados", "schema",
];

const FAST_SIGNALS = [
  "typo", "erro de digitação", "texto", "copy", "renomear", "rename", "readme", "comentário", "comment",
  "bump", "versão", "lint", "formatar", "format", "label", "traduz", "translate", "ícone", "icon", "cor ", "color",
];

const LONG_DESCRIPTION = 1200;
const SHORT_DESCRIPTION = 100;
const MANY_PATHS = 4;

export interface RouteDecision {
  readonly tier: Tier;
  readonly reason: string;
}

const countMatches = (text: string, signals: readonly string[]): readonly string[] => signals.filter((s) => text.includes(s));

/** Deterministic, explainable routing from task text. No extra LLM call, no extra cost. */
export function routeTier(title: string, description: string): RouteDecision {
  const text = `${title}\n${description}`.toLowerCase();
  const deep = countMatches(text, DEEP_SIGNALS);
  const fast = countMatches(text, FAST_SIGNALS);
  const paths = new Set(text.match(/[\w.-]+\/[\w./-]+\.\w{1,5}/g) ?? []).size;

  if (deep.length >= 2 || (deep.length === 1 && description.length > LONG_DESCRIPTION) || paths >= MANY_PATHS) {
    const why = deep.length ? `sinais: ${deep.slice(0, 3).join(", ")}` : `${paths} arquivos citados`;
    return { tier: "deep", reason: `tarefa ampla (${why})` };
  }
  if (fast.length > 0 && deep.length === 0 && description.length < LONG_DESCRIPTION) {
    return { tier: "fast", reason: `tarefa pontual (sinais: ${fast.slice(0, 3).join(", ")})` };
  }
  if (deep.length === 0 && description.length < SHORT_DESCRIPTION && paths <= 1) {
    return { tier: "fast", reason: "descrição curta e escopo pequeno" };
  }
  return { tier: "balanced", reason: deep.length ? `um sinal de complexidade (${deep[0]})` : "escopo médio" };
}

export interface ModelChoice {
  readonly model: string | null;
  readonly effort: Effort | null;
  readonly label: string;
  readonly reason: string;
}

/**
 * Turns the stored choices into CLI arguments plus a human label.
 * Model and effort are independent: "auto" on either one is decided from the task text.
 */
export function resolveModel(
  executor: "claude" | "codex",
  storedModel: string,
  title: string,
  description: string,
  storedEffort: string = AUTO_EFFORT,
): ModelChoice {
  const isAutoModel = storedModel === AUTO_MODEL;
  const isAutoEffort = storedEffort === AUTO_EFFORT || !isValidEffort(executor, storedEffort);
  const route = isAutoModel || isAutoEffort ? routeTier(title, description) : null;

  const model = isAutoModel
    ? executor === "claude" && route ? CLAUDE_BY_TIER[route.tier] : null
    : storedModel === "default" || storedModel === "" ? null : storedModel;
  const effort: Effort = isAutoEffort && route ? EFFORT_BY_TIER[route.tier] : (storedEffort as Effort);

  const label = `${model ?? (executor === "claude" ? "padrão da CLI" : "padrão")} · esforço ${effort}`;
  const parts = [
    isAutoModel ? "modelo auto" : "modelo manual",
    isAutoEffort ? "esforço auto" : "esforço manual",
  ];
  const reason = route ? `${parts.join(", ")} → ${TIER_LABEL[route.tier]}: ${route.reason}` : `${parts.join(", ")}`;
  return { model, effort, label, reason };
}

/** Free-text model names are passed to a CLI argument: keep them to a safe charset. */
export function isValidModelName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(value);
}

const EXECUTOR_NAME: Readonly<Record<"claude" | "codex", string>> = { claude: "Claude Code", codex: "Codex" };

/** "Claude Code · opus · esforço high" — shown in the agent session header and the queue. */
export function executionLabel(executor: "claude" | "codex", choice: ModelChoice): string {
  return `${EXECUTOR_NAME[executor]} · ${choice.label}`;
}
