import { describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import { applyExecutorEvent, emptyContext, type RunContext } from "./apply";
import type { ExecutorEvent } from "../executors/events";

const base: Ticket = {
  id: "t",
  key: "FRG-1",
  title: "x",
  source: "github",
  repo: "r",
  requester: "ana",
  priority: "medium",
  status: "running",
  stage: "intake",
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

function fold(events: readonly ExecutorEvent[]): { ticket: Ticket; ctx: RunContext } {
  return events.reduce((acc, e) => applyExecutorEvent(acc.ticket, acc.ctx, e), { ticket: base, ctx: emptyContext });
}

describe("applyExecutorEvent", () => {
  it("builds plan, stages, tests and findings from markers", () => {
    const { ticket } = fold([
      { type: "text", text: "CARBON_STAGE: plan\nCARBON_PLAN: a\nCARBON_PLAN: b" },
      { type: "text", text: "CARBON_STAGE: code\nCARBON_DONE: 1" },
      { type: "text", text: "CARBON_TESTS: 9/10\nCARBON_FINDING: HIGH | vaza pii" },
      { type: "text", text: "CARBON_FINDING: HIGH | vaza pii [resolved]\nCARBON_TESTS: 10/10" },
    ]);
    expect(ticket.stage).toBe("code");
    expect(ticket.plan.map((s) => [s.text, s.done])).toEqual([["a", true], ["b", false]]);
    expect(ticket.tests).toEqual({ added: 0, passing: 10, total: 10 });
    expect(ticket.findings).toEqual([{ severity: "HIGH", text: "vaza pii", resolved: true }]);
  });

  it("never moves the stage backwards", () => {
    const { ticket } = fold([{ type: "text", text: "CARBON_STAGE: review" }, { type: "text", text: "CARBON_STAGE: plan" }]);
    expect(ticket.stage).toBe("review");
  });

  it("uses agent todo lists as plan only when no marker plan exists", () => {
    const todo: ExecutorEvent = { type: "plan", items: [{ text: "t1", done: false }] };
    expect(fold([todo]).ticket.plan.map((s) => s.text)).toEqual(["t1"]);
    expect(fold([{ type: "text", text: "CARBON_PLAN: m1" }, todo]).ticket.plan.map((s) => s.text)).toEqual(["m1"]);
  });

  it("records research hits from read tools, deduplicated", () => {
    const read: ExecutorEvent = { type: "tool", name: "Read", summary: "src/a.ts", path: "src/a.ts" };
    const { ticket } = fold([read, read, { type: "tool", name: "Edit", summary: "src/b.ts", path: "src/b.ts" }]);
    expect(ticket.hits.map((h) => h.ref)).toEqual(["src/a.ts"]);
    expect(ticket.logs).toHaveLength(3);
  });

  it("collects lessons and questions into the run context", () => {
    const { ctx } = fold([{ type: "text", text: "CARBON_LESSON: isolar store | flaky\nCARBON_QUESTION: qual banco?" }]);
    expect(ctx.lessons).toEqual([{ rule: "isolar store", evidence: "flaky" }]);
    expect(ctx.question).toBe("qual banco?");
  });

  it("accumulates usage and flags errors", () => {
    const { ticket, ctx } = fold([
      { type: "usage", tokens: 100, costUsd: 0.5 },
      { type: "usage", tokens: 50, costUsd: null },
      { type: "error", message: "boom" },
    ]);
    expect(ticket.tokens).toBe(150);
    expect(ctx.costUsd).toBe(0.5);
    expect(ctx.isError).toBe(true);
  });

  it("assigns increasing log ids", () => {
    const { ticket } = fold([{ type: "text", text: "um\ndois" }, { type: "thinking", text: "hmm" }]);
    expect(ticket.logs.map((l) => l.id)).toEqual([1, 2, 3]);
  });
});

describe("permission events", () => {
  it("records a pending prompt and puts the ticket in waiting", () => {
    const { ticket } = fold([
      { type: "permission_request", requestId: "r1", tool: "Bash", summary: "rodar install", detail: "npm i x", input: {}, suggestions: [{}] },
    ]);
    expect(ticket.status).toBe("waiting");
    expect(ticket.permissions).toMatchObject([{ id: "r1", tool: "Bash", status: "pending", canRemember: true }]);
  });

  it("logs denials as warnings", () => {
    const { ticket } = fold([{ type: "permission_denied", tool: "Write", message: "not granted" }]);
    expect(ticket.logs.at(-1)).toMatchObject({ level: "warn", text: "negado: Write — not granted" });
  });
});

describe("plan completion", () => {
  it("marks skipped steps with the agent's reason", () => {
    const { ticket } = fold([{ type: "text", text: "CARBON_PLAN: a\nCARBON_PLAN: b\nCARBON_DONE: 1\nCARBON_SKIPPED: 2 | sem testes e2e no repo" }]);
    expect(ticket.plan.map((s) => [s.done, s.state, s.note])).toEqual([[true, undefined, undefined], [false, "skipped", "sem testes e2e no repo"]]);
  });

  it("reconciles open steps as unconfirmed instead of checking them", async () => {
    const { reconcilePlan } = await import("./apply");
    const { ticket } = fold([{ type: "text", text: "CARBON_PLAN: a\nCARBON_PLAN: b\nCARBON_PLAN: c\nCARBON_DONE: 1\nCARBON_SKIPPED: 2 | x" }]);
    const result = reconcilePlan(ticket);
    expect(result.unconfirmed).toBe(1);
    expect(result.ticket.plan.map((s) => s.state ?? (s.done ? "done" : "open"))).toEqual(["done", "skipped", "unconfirmed"]);
  });
});
