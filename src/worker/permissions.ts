import type { ExecutorEvent, PermissionDecision } from "../shared/executors";
import { LEASE_LOST, type PermissionDecisionWire, type RemotePermissionRule, type RunSettings } from "../shared/worker-protocol";
import { AUTO_APPROVE_LABEL, autoApprovedByTask, classifyAction, decide, ruleMatches } from "../server/permissions/classify";
import { backoffMs, WorkerClientError, type SleepFn, type WorkerClient } from "./client";

type PermissionRequest = Extract<ExecutorEvent, { type: "permission_request" }>;

export interface PermissionOutcome {
  readonly decision: PermissionDecision;
  /** Event sent to the panel instead of the raw request (it was answered without a human). */
  readonly report: ExecutorEvent;
}

/**
 * Answers a permission prompt on the worker with the same policy as the local runner
 * (classifyAction + approval policy + the repo's "always allow" rules + "allow all" for the task).
 * null when it needs a human: the worker forwards it to the panel and waits (RMT-01).
 */
export function answerPermission(event: PermissionRequest, clone: string, settings: RunSettings, rules: readonly RemotePermissionRule[], allowAll = false, autoApprove = false): PermissionOutcome | null {
  const classification = classifyAction(event.tool, event.input, clone);
  const verdict = decide(settings.approvalPolicy, classification);
  if (verdict === "block") {
    const message = `Bloqueado pela política do Carbon (${classification.reason}). Não tente contornar; siga sem essa ação ou pare e explique.`;
    return { decision: { behavior: "deny", message }, report: { type: "permission_denied", tool: event.tool, message: `bloqueio: ${classification.reason}` } };
  }
  const rule = rules.find((r) => ruleMatches(r, event.tool, event.input));
  const byTask = autoApprove && autoApprovedByTask(classification) ? `${AUTO_APPROVE_LABEL} (${classification.reason})` : null;
  const by = allowAll ? "tudo liberado nesta tarefa" : rule ? `regra: ${rule.tool} ${rule.pattern}`.trim() : verdict === "safe" ? `auto: ${classification.reason}` : byTask;
  if (!by) return null;
  return { decision: { behavior: "allow", input: event.input, remember: [] }, report: { type: "tool", name: event.tool, summary: `permitido (${by}): ${event.summary}`, path: null } };
}

export interface PermissionRelayDeps {
  readonly client: WorkerClient;
  readonly taskId: string;
  /** Hands the answer to the running executor. */
  readonly respond: (requestId: string, decision: PermissionDecision) => void;
  /** The panel no longer gives this worker the task. */
  readonly onLeaseLost: () => void;
  readonly initialRules: readonly RemotePermissionRule[];
  readonly log?: (message: string) => void;
  readonly sleep?: SleepFn;
}

export interface PermissionRelay {
  /** Waits for the panel's answer to a prompt already sent as an event. */
  ask(event: PermissionRequest): void;
  /** Repo rules, plus the "always allow" ones humans added during this run. */
  rules(): readonly RemotePermissionRule[];
  /** A human chose "allow everything for the rest of this task". */
  allowAll(): boolean;
  /** Prompts still waiting for an answer. */
  waiting(): number;
  /** Ends the long-poll (run over). Waiting prompts get no answer: the executor is gone. */
  stop(): void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UNREACHABLE = "O painel do Carbon não respondeu a este pedido de permissão; siga sem essa ação ou pare e explique.";

/**
 * Worker half of remote permission prompts: while any forwarded prompt is open, long-polls
 * GET .../permissions?after=<seq> and relays each answer to the executor. The panel owns the
 * timeout (it answers "deny" once permissionTimeoutMinutes pass), so the worker never guesses it.
 */
export function createPermissionRelay(deps: PermissionRelayDeps): PermissionRelay {
  const log = deps.log ?? (() => undefined);
  const sleep = deps.sleep ?? defaultSleep;
  const pending = new Map<string, unknown>();
  const controller = new AbortController();
  let rules: readonly RemotePermissionRule[] = deps.initialRules;
  let allowAll = false;
  let after = 0;
  let polling = false;
  let stopped = false;

  const apply = (d: PermissionDecisionWire): void => {
    after = Math.max(after, d.seq);
    if (d.allowTask) allowAll = true;
    if (d.rule) rules = [...rules, d.rule];
    if (!pending.has(d.requestId)) return;
    const input = pending.get(d.requestId);
    pending.delete(d.requestId);
    deps.respond(
      d.requestId,
      d.behavior === "allow" ? { behavior: "allow", input, remember: [] } : { behavior: "deny", message: d.message ?? "Negado no painel do Carbon; siga sem essa ação ou pare e explique." },
    );
  };

  /** Non-retryable failure: deny what is open so the agent is not stuck until its time limit. */
  const giveUp = (reason: string): void => {
    log(`[permissões] ${reason}`);
    for (const requestId of [...pending.keys()]) {
      pending.delete(requestId);
      deps.respond(requestId, { behavior: "deny", message: UNREACHABLE });
    }
  };

  async function poll(): Promise<void> {
    polling = true;
    let attempt = 0;
    try {
      while (pending.size > 0 && !stopped) {
        let answer: Awaited<ReturnType<WorkerClient["permissions"]>>;
        try {
          answer = await deps.client.permissions(deps.taskId, after, controller.signal);
          attempt = 0;
        } catch (error) {
          if (stopped) return;
          if (error instanceof WorkerClientError && error.retryable) {
            log(`[permissões] ${message(error)} — tentando de novo`);
            await sleep(backoffMs(attempt++, Math.random));
            continue;
          }
          return giveUp(`não consegui consultar o painel: ${message(error)}`);
        }
        if (answer === LEASE_LOST) return deps.onLeaseLost();
        for (const d of answer.decisions) apply(d);
      }
    } finally {
      polling = false;
    }
  }

  return {
    ask(event) {
      if (stopped) return;
      pending.set(event.requestId, event.input);
      if (!polling) void poll();
    },
    rules: () => rules,
    allowAll: () => allowAll,
    waiting: () => pending.size,
    stop() {
      stopped = true;
      pending.clear();
      controller.abort();
    },
  };
}
