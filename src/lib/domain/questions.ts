import type { AgentQuestion, QuestionOption, Ticket } from "./types";

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

// "A) tirar do repo (recomendo) ou B) subir como está?" → two options.
const LETTERED_RE = /(?:^|[\s:;,(])([A-D])\)\s+([\s\S]+?)(?=\s+(?:ou\s+|or\s+)?[A-D]\)\s|[?.!]?\s*$)/g;
const RECOMMEND_RE = /\b(recomendo|recomendad[oa]|recommended)\b[;,:]?\s*/i;
const MAX_INFERRED_LABEL = 120;

/** Options written inside the question text, for questions asked without CARBON_OPTION lines. */
export function inferOptions(text: string): readonly QuestionOption[] {
  const found = [...text.matchAll(LETTERED_RE)];
  if (found.length < 2) return [];
  return found.map(([, letter, body = ""]) => {
    const recommended = RECOMMEND_RE.test(body);
    const clean = body.replace(RECOMMEND_RE, "").replace(/\(\s*\)/g, "").replace(/\s+/g, " ").replace(/[\s;,]+$/, "").trim();
    // "do X (consequence)" → label "do X", detail "consequence"
    const paren = /^(.*?)\s*\(([^()]+)\)$/.exec(clean);
    return {
      label: `${letter}) ${paren?.[1] ?? clean}`.slice(0, MAX_INFERRED_LABEL),
      detail: paren?.[2]?.trim() || null,
      recommended,
    };
  });
}

/** What the panel offers as one-click answers: the agent's options, or ones found in the text. */
export const optionsOf = (question: AgentQuestion): readonly QuestionOption[] =>
  question.options && question.options.length > 0 ? question.options : inferOptions(question.text);

/** Text sent back to the agent when the human clicks an option. */
export const answerFromOption = (option: QuestionOption): string =>
  option.detail ? `${option.label} — ${option.detail}` : option.label;
