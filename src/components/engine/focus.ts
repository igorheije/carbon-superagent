import type { Ticket } from "@/lib/domain/types";

/**
 * Ticket the grid (terminal, plan, artifacts, delivery) shows: the one picked in the queue; else
 * the local runner's active one; else one running on ANY machine (pool/AgentCore tasks are never
 * the local "active" ticket); else the most recent non-queued one.
 */
export function pickFocusTicket(tickets: readonly Ticket[], activeTicket: Ticket | null, focusedTicketId: string | null): Ticket | null {
  const picked = focusedTicketId ? tickets.find((t) => t.id === focusedTicketId) : undefined;
  if (picked) return picked;
  if (activeTicket) return activeTicket;
  const runningElsewhere = tickets.filter((t) => t.status === "running" || t.status === "waiting");
  if (runningElsewhere.length > 0) return runningElsewhere.at(-1) ?? null;
  return tickets.filter((t) => t.status !== "queued").at(-1) ?? null;
}
