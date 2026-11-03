import { pendingQuestionsOf, questionsOf } from "@/lib/domain/questions";
import type { AgentQuestion, QuestionOption, StageId, Ticket } from "@/lib/domain/types";
import { appendLog } from "./ticket-log";

export const MAX_ANSWER = 4_000;
const LOG_PREVIEW = 160;

const preview = (text: string): string => (text.length > LOG_PREVIEW ? `${text.slice(0, LOG_PREVIEW - 1)}…` : text);

export const pendingQuestions = pendingQuestionsOf;

export const answeredQuestions = (ticket: Ticket): readonly AgentQuestion[] =>
  (ticket.questions ?? []).filter((q) => q.answer !== null);

/** Records a question the agent asked. The full text lives on the question; the log gets a preview. */
export function addQuestion(ticket: Ticket, stage: StageId, text: string, askedAt: string): Ticket {
  const questions = ticket.questions ?? [];
  const question: AgentQuestion = {
    id: `${ticket.id}-q${questions.length + 1}`,
    stage,
    text,
    askedAt,
    answer: null,
    answeredBy: null,
    answeredAt: null,
  };
  const logged = appendLog(ticket, stage, "warn", `pergunta: ${preview(text)}`);
  return { ...logged, questions: [...questions, question] };
}

const MAX_OPTIONS = 6;

/** Attaches a CARBON_OPTION to the most recent pending question. Ignored when there is none. */
export function addOption(ticket: Ticket, option: QuestionOption): Ticket {
  const questions = ticket.questions ?? [];
  const last = questions.at(-1);
  if (!last || last.answer !== null || (last.options?.length ?? 0) >= MAX_OPTIONS) return ticket;
  const updated = { ...last, options: [...(last.options ?? []), option] };
  return { ...ticket, questions: [...questions.slice(0, -1), updated] };
}

export type AnswerResult = { readonly ok: true; readonly ticket: Ticket; readonly resumes: boolean } | { readonly ok: false; readonly error: string };

/**
 * Stores a human answer. Once nothing is pending, the ticket goes back to the queue
 * flagged to resume: the next run continues the same work instead of starting over.
 */
export function answerQuestion(ticket: Ticket, questionId: string, rawAnswer: string, by: string, answeredAt: string): AnswerResult {
  if (ticket.status !== "waiting") return { ok: false, error: "esta tarefa não está aguardando resposta" };
  const answer = rawAnswer.trim().slice(0, MAX_ANSWER);
  if (!answer) return { ok: false, error: "a resposta não pode ficar vazia" };
  const known = questionsOf(ticket);
  const target = known.find((q) => q.id === questionId);
  if (!target) return { ok: false, error: "pergunta não encontrada" };
  if (target.answer !== null) return { ok: false, error: "essa pergunta já foi respondida" };

  const questions = known.map((q) => (q.id === questionId ? { ...q, answer, answeredBy: by, answeredAt } : q));
  const answered = appendLog({ ...ticket, questions }, target.stage, "ok", `${by} respondeu: ${preview(answer)}`);
  const resumes = pendingQuestions(answered).length === 0;
  if (!resumes) return { ok: true, ticket: answered, resumes };
  const queued = appendLog(answered, target.stage, "info", "na fila para continuar de onde parou");
  return { ok: true, ticket: { ...queued, status: "queued", resume: true }, resumes };
}

/** Prompt section with every decision already made, so the agent never asks the same thing twice. */
export function decisionsSection(questions: readonly AgentQuestion[]): string {
  if (questions.length === 0) return "";
  const items = questions.map((q, i) => `${i + 1}. Question: ${q.text}\n   Answer from ${q.answeredBy ?? "the human"}: ${q.answer}`).join("\n");
  return `## Decisions already made by the human (binding; do not ask these again)
<human-decisions>
${items}
</human-decisions>`;
}

/** Message sent into a resumed agent session after the human answered. */
export function resumeMessage(questions: readonly AgentQuestion[]): string {
  const items = questions.map((q) => `Question: ${q.text}\nAnswer from ${q.answeredBy ?? "the human"}: ${q.answer}`).join("\n\n");
  return `The human answered your question in the Carbon panel.

<human-decisions>
${items}
</human-decisions>

Continue the task from where you stopped, in this same worktree. Your previous changes are still there.
Keep printing the progress markers (CARBON_STAGE, CARBON_DONE, CARBON_SKIPPED, CARBON_TESTS, CARBON_FINDING, CARBON_LESSON).
Your plan is kept: only print CARBON_PLAN lines again if the answer changes the plan, and then print the whole new plan.
Ask another CARBON_QUESTION only if a new decision blocks you.`;
}
