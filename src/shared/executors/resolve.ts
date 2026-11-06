export type ExecutorName = "claude" | "codex";

export interface ExecutorAvailability {
  readonly claude: boolean;
  readonly codex: boolean;
}

export type ResolveResult =
  | { readonly ok: true; readonly executor: ExecutorName }
  | { readonly ok: false; readonly error: string };

const LABEL: Readonly<Record<ExecutorName, string>> = { claude: "Claude Code", codex: "Codex" };
const other = (e: ExecutorName): ExecutorName => (e === "claude" ? "codex" : "claude");

/**
 * Carbon needs ONE executor, not both.
 * - explicit request: must be installed (clear error otherwise)
 * - no request: the configured default, or the other one if the default is missing
 */
export function resolveExecutor(
  requested: ExecutorName | undefined,
  fallbackDefault: ExecutorName,
  available: ExecutorAvailability,
): ResolveResult {
  if (!available.claude && !available.codex) {
    return { ok: false, error: "nenhum agente instalado: instale Claude Code ou Codex (basta um)" };
  }
  if (requested) {
    return available[requested]
      ? { ok: true, executor: requested }
      : { ok: false, error: `${LABEL[requested]} não está instalado nesta máquina; use ${LABEL[other(requested)]}` };
  }
  return { ok: true, executor: available[fallbackDefault] ? fallbackDefault : other(fallbackDefault) };
}
