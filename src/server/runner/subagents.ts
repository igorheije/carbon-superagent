import type { SubagentRun, SubagentStatus, Ticket } from "@/lib/domain/types";

/** Keeps the snapshot bounded even if an agent delegates in a loop. */
export const MAX_SUBAGENTS = 40;

type Stored = SubagentRun & { readonly isBackground?: boolean };

const list = (ticket: Ticket): readonly Stored[] => ticket.subagents ?? [];

export function startSubagent(
  ticket: Ticket,
  input: { readonly id: string; readonly description: string; readonly agentType: string; readonly isBackground: boolean },
  now: string,
): Ticket {
  const current = list(ticket);
  const existing = current.find((a) => a.id === input.id);
  // The Agent tool call and Claude Code's task_started both announce the same sub-agent.
  if (existing) {
    if (!input.isBackground || existing.isBackground) return ticket;
    return { ...ticket, subagents: current.map((a) => (a.id === input.id ? { ...a, isBackground: true } : a)) };
  }
  const run: Stored = {
    id: input.id,
    label: input.description,
    agentType: input.agentType,
    status: "running",
    startedAt: now,
    endedAt: null,
    toolCalls: 0,
    lastActivity: null,
    ...(input.isBackground ? { isBackground: true } : {}),
  };
  return { ...ticket, subagents: [...current, run].slice(-MAX_SUBAGENTS) };
}

/** Counts a tool call made by a sub-agent; unknown ids (e.g. nested agents) are ignored. */
export function recordSubagentActivity(ticket: Ticket, agentId: string, activity: string): Ticket {
  const current = list(ticket);
  if (!current.some((a) => a.id === agentId)) return ticket;
  return { ...ticket, subagents: current.map((a) => (a.id === agentId ? { ...a, toolCalls: a.toolCalls + 1, lastActivity: activity } : a)) };
}

/** Claude Code's own count of the sub-agent's tool uses wins over what was seen in the stream. */
export function recordSubagentProgress(ticket: Ticket, agentId: string, toolCalls: number, lastTool: string): Ticket {
  const current = list(ticket);
  const target = current.find((a) => a.id === agentId);
  if (!target || target.status !== "running") return ticket;
  const lastActivity = lastTool && !target.lastActivity?.startsWith(lastTool) ? lastTool : target.lastActivity;
  const next = { ...target, toolCalls: Math.max(target.toolCalls, toolCalls), lastActivity };
  return { ...ticket, subagents: current.map((a) => (a.id === agentId ? next : a)) };
}

/** End reported by Claude Code itself (task_notification): applies to background sub-agents too. */
export function endSubagent(ticket: Ticket, agentId: string, isError: boolean, now: string): { ticket: Ticket; finished: SubagentRun | null } {
  const current = list(ticket);
  const target = current.find((a) => a.id === agentId);
  if (!target || target.status !== "running") return { ticket, finished: null };
  const finished: Stored = { ...target, status: isError ? "failed" : "done", endedAt: now };
  return { ticket: { ...ticket, subagents: current.map((a) => (a.id === agentId ? finished : a)) }, finished };
}

/**
 * Ends the sub-agent whose call returned. Background sub-agents return right away ("launched"),
 * so they stay running until the whole run ends.
 */
export function finishSubagent(ticket: Ticket, toolUseId: string, isError: boolean, now: string): { ticket: Ticket; finished: SubagentRun | null } {
  if (list(ticket).find((a) => a.id === toolUseId)?.isBackground) return { ticket, finished: null };
  return endSubagent(ticket, toolUseId, isError, now);
}

/** When the run ends (any reason), nothing can still be running. */
export function closeRunningSubagents(ticket: Ticket, status: SubagentStatus, now: string): Ticket {
  const current = list(ticket);
  if (!current.some((a) => a.status === "running")) return ticket;
  return { ...ticket, subagents: current.map((a) => (a.status === "running" ? { ...a, status, endedAt: now } : a)) };
}
