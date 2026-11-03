import type { AgentQuestion, Ticket } from "./types";

export const LEGACY_QUESTION_ID = "legacy";
const LEGACY_PREFIX = "pergunta: ";

/**
 * Tickets stopped before questions were stored on the ticket only have the question in the log.
 * Rebuild it so those tasks can be answered and resumed too.
 */
function legacyQuestion(ticket: Ticket): AgentQuestion | null {
  if (ticket.status !== "waiting" || (ticket.questions?.length ?? 0) > 0) return null;
  const line = [...ticket.logs].reverse().find((l) => l.level === "warn" && l.text.startsWith(LEGACY_PREFIX));
  if (!line) return null;
  return {
    id: LEGACY_QUESTION_ID,
    stage: line.stage,
    text: line.text.slice(LEGACY_PREFIX.length),
    askedAt: "",
    answer: null,
    answeredBy: null,
    answeredAt: null,
  };
}

/** Questions on the ticket, plus a rebuilt legacy one when the ticket predates stored questions. */
export function questionsOf(ticket: Ticket): readonly AgentQuestion[] {
  const legacy = legacyQuestion(ticket);
  return legacy ? [legacy] : (ticket.questions ?? []);
}

export const pendingQuestionsOf = (ticket: Ticket): readonly AgentQuestion[] => questionsOf(ticket).filter((q) => q.answer === null);
