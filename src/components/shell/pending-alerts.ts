import { pendingQuestionsOf } from "@/lib/domain/questions";
import type { Ticket } from "@/lib/domain/types";

/** Something an agent is blocked on, shown as a fixed alert on every page. */
export type PendingAlert =
  | { readonly kind: "permission"; readonly id: string; readonly ticket: Ticket; readonly tool: string; readonly summary: string; readonly at: string }
  | { readonly kind: "question"; readonly id: string; readonly ticket: Ticket; readonly text: string; readonly at: string };

/** Permissions first (they expire and auto-deny), then questions; oldest first inside each group. */
export function pendingAlertsOf(tickets: readonly Ticket[]): readonly PendingAlert[] {
  const permissions: PendingAlert[] = tickets.flatMap((ticket) =>
    (ticket.permissions ?? [])
      .filter((p) => p.status === "pending")
      .map((p) => ({ kind: "permission" as const, id: `p:${ticket.id}:${p.id}`, ticket, tool: p.tool, summary: p.summary, at: p.askedAt })),
  );
  const questions: PendingAlert[] = tickets.flatMap((ticket) =>
    pendingQuestionsOf(ticket).map((q) => ({ kind: "question" as const, id: `q:${ticket.id}:${q.id}`, ticket, text: q.text, at: q.askedAt })),
  );
  const byAge = (a: PendingAlert, b: PendingAlert) => a.at.localeCompare(b.at);
  return [...permissions.sort(byAge), ...questions.sort(byAge)];
}

/** True when an alert appeared that was not there before (the stack re-opens itself for it). */
export function hasNewAlert(previous: ReadonlySet<string>, current: readonly PendingAlert[]): boolean {
  return current.some((a) => !previous.has(a.id));
}
