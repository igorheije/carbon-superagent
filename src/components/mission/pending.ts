import type { PermissionPrompt, TaskRuntime, Ticket } from "@/lib/domain/types";

/** A permission prompt still waiting for a human, with the task that raised it. */
export interface PendingPermission {
  readonly ticket: Ticket;
  readonly prompt: PermissionPrompt;
}

/**
 * Every pending permission prompt across the queue, oldest first. With several remote tasks
 * blocked at once, each one must be answerable from the panel — not only the focused ticket.
 */
export function pendingPermissionsOf(tickets: readonly Ticket[]): readonly PendingPermission[] {
  return tickets
    .flatMap((ticket) => (ticket.permissions ?? []).filter((p) => p.status === "pending").map((prompt) => ({ ticket, prompt })))
    .sort((a, b) => a.prompt.askedAt.localeCompare(b.prompt.askedAt));
}

const REMOTE_TARGET: Readonly<Record<Exclude<TaskRuntime, "local">, string>> = { pool: "um worker do pool", agentcore: "uma nova sessão AgentCore" };

/**
 * What happens after a question is answered. Local runs resume the same agent session in the same
 * worktree; remote runs (pool/AgentCore) go back to the queue and restart from the base branch,
 * with the answered decisions added to the prompt (no remote --resume).
 */
export function resumeHint(runtime: TaskRuntime | undefined, hasOptions: boolean): string {
  const what =
    !runtime || runtime === "local"
      ? "a tarefa continua de onde parou, no mesmo worktree."
      : `a tarefa volta para a fila e recomeça da base em ${REMOTE_TARGET[runtime]}, com suas decisões no prompt.`;
  return hasOptions ? `Um clique responde e ${what}` : `Ao responder, ${what} ⌘/Ctrl + Enter envia.`;
}
