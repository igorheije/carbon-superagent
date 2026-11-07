import type { Ticket, TicketStatus, TaskRuntime } from "@/lib/domain/types";

/**
 * Where a task ran (FLT-01 §2). Source of truth is `ticket.placement`, recorded by prepare-claim
 * on every remote claim. Tasks claimed before that field existed fall back to the claim log line
 * ("worker <nome> assumiu a tarefa"; AgentCore containers claim as "AgentCore <sessão>"); when
 * that line is gone too (log truncated), only the kind shows.
 */
export interface Placement {
  readonly runtime: TaskRuntime;
  /** Short text for the queue row. */
  readonly short: string;
  /** Full text for the task detail: "rodou em: worker sp-01". */
  readonly label: string;
}

const CLAIM_LOG = /^worker (.+) assumiu a tarefa$/;
const AGENTCORE_NAME = /^AgentCore (\S+)$/;
const MAX_SESSION_CHARS = 24;

function claimedBy(ticket: Pick<Ticket, "logs">): string | null {
  for (let i = ticket.logs.length - 1; i >= 0; i -= 1) {
    const match = CLAIM_LOG.exec(ticket.logs[i].text);
    if (match) return match[1];
  }
  return null;
}

function verbOf(status: TicketStatus): string {
  if (status === "queued") return "vai rodar em";
  if (status === "running" || status === "waiting") return "rodando em";
  return "rodou em";
}

const ellipsis = (text: string): string => (text.length > MAX_SESSION_CHARS ? `${text.slice(0, MAX_SESSION_CHARS)}…` : text);

function target(runtime: TaskRuntime, who: string | null): { readonly short: string; readonly full: string } {
  if (runtime === "local") return { short: "esta máquina", full: "esta máquina" };
  if (runtime === "agentcore") {
    const session = who ? AGENTCORE_NAME.exec(who)?.[1] : undefined;
    return { short: "AgentCore", full: session ? `AgentCore (sessão ${ellipsis(session)})` : "AgentCore" };
  }
  return who ? { short: who, full: `worker ${who}` } : { short: "pool", full: "pool de workers" };
}

type PlacementSource = Pick<Ticket, "runtime" | "status" | "logs" | "placement">;

/** Worker label from the persisted placement, in the same shape the claim log line carries. */
function persistedWho(ticket: PlacementSource): string | null {
  const placement = ticket.placement;
  if (!placement || placement.runtime !== (ticket.runtime ?? "local")) return null;
  if (placement.agentcoreSessionId) return `AgentCore ${placement.agentcoreSessionId}`;
  return placement.workerName;
}

export function placementOf(ticket: PlacementSource): Placement {
  const runtime = ticket.runtime ?? "local";
  const who = ticket.status === "queued" ? null : (persistedWho(ticket) ?? claimedBy(ticket));
  const { short, full } = target(runtime, who);
  return { runtime, short, label: `${verbOf(ticket.status)}: ${full}` };
}

/** One step of the execution trail shown in the badge tooltip and in the task detail. */
export interface TrailStep {
  readonly where: string;
  readonly isLocal: boolean;
  readonly state: "running" | "done" | "failed" | "waiting" | "stopped";
}

const STATE_OF: Readonly<Record<string, TrailStep["state"]>> = { done: "done", failed: "failed", lost: "failed", waiting: "waiting", canceled: "stopped" };
const GLYPH: Readonly<Record<TrailStep["state"], string>> = { running: "●", done: "✓", failed: "✗", waiting: "?", stopped: "■" };

/** Executions of the task, oldest first ("esta máquina", then a worker, …). */
export function runTrail(ticket: Pick<Ticket, "runs">): readonly TrailStep[] {
  return (ticket.runs ?? []).map((run) => ({ where: run.where, isLocal: run.isLocal, state: run.outcome === null ? "running" : (STATE_OF[run.outcome] ?? "stopped") }));
}

/** True when the task ran on more than one machine (e.g. failed here, retried on a worker). */
export function isMixed(trail: readonly TrailStep[]): boolean {
  return new Set(trail.map((s) => s.where)).size > 1;
}

/** "esta máquina ✗ → vps-sp-01 ●" */
export function trailText(trail: readonly TrailStep[]): string {
  return trail.map((s) => `${s.where} ${GLYPH[s.state]}`).join(" → ");
}
