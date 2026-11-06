import type { Ticket, TicketStatus, TaskRuntime } from "@/lib/domain/types";

/**
 * Where a task ran (FLT-01 §2), derived from what the ticket snapshot already carries: the runtime
 * and the claim log line written by prepare-claim ("worker <nome> assumiu a tarefa"). AgentCore
 * containers claim as "AgentCore <sessão>". When the line is gone (log truncated), only the kind shows.
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

export function placementOf(ticket: Pick<Ticket, "runtime" | "status" | "logs">): Placement {
  const runtime = ticket.runtime ?? "local";
  const who = ticket.status === "queued" ? null : claimedBy(ticket);
  const { short, full } = target(runtime, who);
  return { runtime, short, label: `${verbOf(ticket.status)}: ${full}` };
}
