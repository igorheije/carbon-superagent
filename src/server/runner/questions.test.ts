import { describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import { LEGACY_QUESTION_ID, pendingQuestionsOf } from "@/lib/domain/questions";
import { applyExecutorEvent, emptyContext } from "./apply";
import { addQuestion, answerQuestion, answeredQuestions, decisionsSection, resumeMessage } from "./questions";

const NOW = "2026-11-02T22:00:00.000Z";

const base: Ticket = {
  id: "t1",
  key: "FRG-3",
  title: "README",
  source: "github",
  repo: "r",
  requester: "ana",
  priority: "medium",
  status: "running",
  stage: "research",
  cursor: 0,
  totalEvents: 0,
  plan: [],
  logs: [],
  hits: [],
  diff: [],
  findings: [],
  tests: null,
  pr: null,
  tokens: 0,
  model: null,
  startedAtTick: null,
  endedAtTick: null,
};

const waitingWith = (...texts: string[]): Ticket =>
  texts.reduce<Ticket>((t, text) => addQuestion(t, "research", text, NOW), { ...base, status: "waiting" });

describe("CARBON_QUESTION marker", () => {
  it("stores the full question on the ticket and only a preview in the log", () => {
    const long = `Você aprova a spec? ${"x".repeat(900)} Responda "aprova".`;
    const { ticket, ctx } = applyExecutorEvent(base, emptyContext, { type: "text", text: `CARBON_QUESTION: ${long}` });
    expect(ticket.questions).toHaveLength(1);
    expect(ticket.questions?.[0]?.text).toBe(long);
    expect(ticket.questions?.[0]?.answer).toBeNull();
    expect(ticket.logs.at(-1)?.text.length).toBeLessThan(200);
    expect(ctx.question).toBe(long);
  });

  it("attaches CARBON_OPTION lines to the question right above them", () => {
    const text = [
      "CARBON_QUESTION: Em qual repositório subir?",
      "CARBON_OPTION: leolegends/instagram (recomendado) | novo, privado",
      "- **CARBON_OPTION:** leolegends/ig-carrosseis | novo, privado",
      "CARBON_QUESTION: O que fazer com os vídeos?",
      "CARBON_OPTION: Tirar do repo | continuam no disco [recommended]",
      "CARBON_OPTION: Subir como está",
    ].join("\n");
    const { ticket } = applyExecutorEvent(base, emptyContext, { type: "text", text });
    expect(ticket.questions?.map((q) => q.options)).toEqual([
      [
        { label: "leolegends/instagram", detail: "novo, privado", recommended: true },
        { label: "leolegends/ig-carrosseis", detail: "novo, privado", recommended: false },
      ],
      [
        { label: "Tirar do repo", detail: "continuam no disco", recommended: true },
        { label: "Subir como está", detail: null, recommended: false },
      ],
    ]);
  });

  it("ignores an option with no question before it", () => {
    const { ticket } = applyExecutorEvent(base, emptyContext, { type: "text", text: "CARBON_OPTION: solta" });
    expect(ticket.questions ?? []).toEqual([]);
  });

  it("keeps the session id on the ticket so a later run can resume it", () => {
    const { ticket } = applyExecutorEvent(base, emptyContext, { type: "session", sessionId: "ab7181dd-1111", model: "opus" });
    expect(ticket.sessionId).toBe("ab7181dd-1111");
  });
});

describe("answerQuestion", () => {
  it("requeues the task to resume once the last pending question is answered", () => {
    const ticket = waitingWith("Aprova a spec?");
    const result = answerQuestion(ticket, "t1-q1", "  aprova  ", "Ana", NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resumes).toBe(true);
    expect(result.ticket.status).toBe("queued");
    expect(result.ticket.resume).toBe(true);
    expect(result.ticket.questions?.[0]).toMatchObject({ answer: "aprova", answeredBy: "Ana", answeredAt: NOW });
    expect(result.ticket.logs.some((l) => l.text.startsWith("Ana respondeu: aprova"))).toBe(true);
  });

  it("stays waiting while another question is still pending", () => {
    const ticket = waitingWith("Primeira?", "Segunda?");
    const result = answerQuestion(ticket, "t1-q1", "sim", "Ana", NOW);
    expect(result.ok && result.resumes).toBe(false);
    if (!result.ok) return;
    expect(result.ticket.status).toBe("waiting");
    expect(pendingQuestionsOf(result.ticket).map((q) => q.id)).toEqual(["t1-q2"]);
  });

  it("rejects empty answers, unknown ids, repeated answers and tasks not waiting", () => {
    const ticket = waitingWith("Aprova?");
    expect(answerQuestion(ticket, "t1-q1", "   ", "Ana", NOW)).toEqual({ ok: false, error: "a resposta não pode ficar vazia" });
    expect(answerQuestion(ticket, "nope", "sim", "Ana", NOW)).toEqual({ ok: false, error: "pergunta não encontrada" });
    expect(answerQuestion({ ...ticket, status: "running" }, "t1-q1", "sim", "Ana", NOW).ok).toBe(false);
    const first = waitingWith("A?", "B?");
    const once = answerQuestion(first, "t1-q1", "sim", "Ana", NOW);
    if (!once.ok) throw new Error("expected ok");
    expect(answerQuestion(once.ticket, "t1-q1", "de novo", "Ana", NOW)).toEqual({ ok: false, error: "essa pergunta já foi respondida" });
  });

  it("answers a question from a ticket stopped before questions were stored (log only)", () => {
    const legacy: Ticket = {
      ...base,
      status: "waiting",
      logs: [
        { id: 1, stage: "research", level: "warn", text: "pergunta: Você aprova a spec quick?" },
        { id: 2, stage: "research", level: "warn", text: "aguardando sua decisão (veja a pergunta no log)" },
      ],
    };
    expect(pendingQuestionsOf(legacy).map((q) => q.text)).toEqual(["Você aprova a spec quick?"]);
    const result = answerQuestion(legacy, LEGACY_QUESTION_ID, "aprova", "Ana", NOW);
    expect(result.ok && result.resumes).toBe(true);
    if (!result.ok) return;
    expect(answeredQuestions(result.ticket)).toHaveLength(1);
    expect(pendingQuestionsOf(result.ticket)).toHaveLength(0);
  });
});

describe("prompts with decisions", () => {
  it("lists answered questions as binding decisions", () => {
    const answered = answerQuestion(waitingWith("Portas 3014/50052?"), "t1-q1", "sim, use essas", "Ana", NOW);
    if (!answered.ok) throw new Error("expected ok");
    const decisions = answeredQuestions(answered.ticket);
    const section = decisionsSection(decisions);
    expect(section).toContain("do not ask these again");
    expect(section).toContain("Portas 3014/50052?");
    expect(section).toContain("Answer from Ana: sim, use essas");
    expect(resumeMessage(decisions)).toContain("Continue the task from where you stopped");
    expect(decisionsSection([])).toBe("");
  });
});
