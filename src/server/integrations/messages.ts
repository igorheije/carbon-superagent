import type { Ticket } from "@/lib/domain/types";
import type { TaskEvent } from "../runner/runner";

const MAX_TITLE = 120;
const PR_LOG_RE = /^PR (https:\/\/\S+)/;

/** First line of a chat message, as a task title. */
export function titleFrom(text: string): string {
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  return first.length > MAX_TITLE ? `${first.slice(0, MAX_TITLE - 1)}…` : first;
}

/** PR URL the deliver stage logged, if any. */
export const prUrlOf = (ticket: Ticket): string | null =>
  [...ticket.logs].reverse().map((l) => PR_LOG_RE.exec(l.text)?.[1]).find((url): url is string => Boolean(url)) ?? null;

/** One-line status for chat and Jira comments. Returns null for events not worth a message. */
export function eventLine(event: TaskEvent, ticket: Ticket, panelUrl: string | null): string | null {
  const head = `${ticket.key} · ${ticket.title}`;
  const link = panelUrl ? `\n${panelUrl}` : "";
  switch (event.type) {
    case "started":
      return `▶️ ${head}\n${event.detail === "começando" ? "começou" : event.detail}${ticket.model ? ` · ${ticket.model}` : ""}`;
    case "done": {
      const pr = prUrlOf(ticket);
      return `✅ ${head}\n${pr ? `PR pronto para revisão: ${pr}` : "concluída (sem PR: revise o commit no painel)"}${link}`;
    }
    case "failed":
      return `⚠️ ${head}\nfalhou: ${event.detail}${link}`;
    case "question":
      return `❓ ${head}\nprecisa de uma decisão${link}`;
  }
}

export const queuedLine = (ticket: Ticket): string => `📥 ${ticket.key} na fila do Carbon: ${ticket.title}`;
