import type { LogLevel, StageId, Ticket } from "@/lib/domain/types";

export const MAX_LOGS = 400;

export function appendLog(ticket: Ticket, stage: StageId, level: LogLevel, text: string): Ticket {
  const lastId = ticket.logs.at(-1)?.id ?? 0;
  const line = { id: lastId + 1, stage, level, text };
  return { ...ticket, logs: [...ticket.logs, line].slice(-MAX_LOGS) };
}
