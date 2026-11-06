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
