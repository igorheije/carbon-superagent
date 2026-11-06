import type { ExecutorEvent, PermissionDecision } from "../shared/executors";
import type { RemotePermissionRule, RunSettings } from "../shared/worker-protocol";
import { classifyAction, decide, ruleMatches } from "../server/permissions/classify";

type PermissionRequest = Extract<ExecutorEvent, { type: "permission_request" }>;

export interface PermissionOutcome {
  readonly decision: PermissionDecision;
  /** Event sent to the panel instead of the raw request (the panel cannot answer prompts yet). */
  readonly report: ExecutorEvent;
}

/**
 * Answers a permission prompt on the worker with the same policy as the local runner
 * (classifyAction + approval policy + the repo's "always allow" rules resolved by the panel).
 * A prompt that would need a human is denied: answering it from the panel is RMT-01 (P2), and
 * forwarding it would leave the ticket "waiting" with nobody able to reply.
 */
export function answerPermission(event: PermissionRequest, clone: string, settings: RunSettings, rules: readonly RemotePermissionRule[]): PermissionOutcome {
  const classification = classifyAction(event.tool, event.input, clone);
  const verdict = decide(settings.approvalPolicy, classification);
  if (verdict === "block") {
    const message = `Bloqueado pela política do Carbon (${classification.reason}). Não tente contornar; siga sem essa ação ou pare e explique.`;
    return { decision: { behavior: "deny", message }, report: { type: "permission_denied", tool: event.tool, message: `bloqueio: ${classification.reason}` } };
  }
  const rule = rules.find((r) => ruleMatches(r, event.tool, event.input));
  if (rule || verdict === "safe") {
    const by = rule ? `regra: ${rule.tool} ${rule.pattern}`.trim() : `auto: ${classification.reason}`;
    return { decision: { behavior: "allow", input: event.input, remember: [] }, report: { type: "tool", name: event.tool, summary: `permitido (${by}): ${event.summary}`, path: null } };
  }
  const message = "Esta ação precisa de aprovação humana, que ainda não é possível em execução remota. Siga sem ela ou pare e explique.";
  return { decision: { behavior: "deny", message }, report: { type: "permission_denied", tool: event.tool, message: `precisa de aprovação humana (execução remota): ${event.summary}` } };
}
