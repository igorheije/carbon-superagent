import { describe, expect, it } from "vitest";
import { computeEfficiency, formatDuration, interventionsOf } from "./efficiency";
import type { Ticket } from "./types";

const base: Ticket = {
  id: "t", key: "FRG-1", title: "x", source: "github", repo: "r", requester: "ana", priority: "medium",
  status: "done", stage: "reflect", cursor: 0, totalEvents: 0, plan: [], logs: [], hits: [], diff: [],
  findings: [], tests: null, pr: null, tokens: 0, model: null, startedAtTick: null, endedAtTick: null,
};
const ticket = (over: Partial<Ticket>): Ticket => ({ ...base, ...over });
const QUESTION = { id: "q", stage: "plan" as const, text: "?", askedAt: "", answer: "sim", answeredBy: "Ana", answeredAt: "" };
const PERMISSION = { id: "p", tool: "Bash", summary: "", detail: "", canRemember: false, status: "allowed" as const, decidedBy: "Ana", askedAt: "" };

describe("computeEfficiency", () => {
  const tickets = [
    ticket({ id: "1", pr: { number: 1, branch: "a", draft: true }, plan: [{ id: "a", text: "a", done: true }, { id: "b", text: "b", done: true }], tests: { added: 1, passing: 10, total: 10 }, runSeconds: 120, costUsd: 0.4, tokens: 1000 }),
    ticket({ id: "2", plan: [{ id: "c", text: "c", done: true }, { id: "d", text: "d", done: false }], findings: [{ severity: "HIGH", text: "x", resolved: true }, { severity: "LOW", text: "y", resolved: false }], questions: [QUESTION], runSeconds: 240, costUsd: 0.6, tokens: 3000 }),
    ticket({ id: "3", status: "failed", findings: [{ severity: "CRITICAL", text: "z", resolved: false }], permissions: [PERMISSION], tests: { added: 0, passing: 3, total: 5 } }),
    ticket({ id: "4", status: "running" }),
  ];
  const m = computeEfficiency(tickets);

  it("counts only finished tasks for success and autonomy", () => {
    expect(m.finished).toBe(3);
    expect(m.success).toEqual({ value: 2 / 3, part: 2, whole: 3 });
    expect(m.autonomy).toEqual({ value: 1 / 3, part: 1, whole: 3 });
    expect(m.interventionsPerTask).toBeCloseTo(2 / 3);
  });

  it("measures delivery, plan, tests and blocking findings", () => {
    expect(m.delivery).toEqual({ value: 0.5, part: 1, whole: 2 });
    expect(m.plan).toEqual({ value: 0.75, part: 3, whole: 4 });
    expect(m.tests).toEqual({ value: 13 / 15, part: 13, whole: 15 });
    expect(m.review).toEqual({ value: 0.5, part: 1, whole: 2 });
  });

  it("averages time, cost and tokens only over tasks that report them", () => {
    expect(m.avgRunSeconds).toBe(180);
    expect(m.avgCostUsd).toBeCloseTo(0.5);
    expect(m.avgTokens).toBe(2000);
  });

  it("usefulness is the plain average of the rates with data", () => {
    const expected = (2 / 3 + 0.5 + 1 / 3 + 0.75 + 13 / 15 + 0.5) / 6;
    expect(m.usefulness).toBeCloseTo(expected);
    expect(m.usefulnessParts).toBe(6);
  });

  it("returns no rates (not zeros) when there is no data", () => {
    const empty = computeEfficiency([ticket({ status: "queued" })]);
    expect(empty.success.value).toBeNull();
    expect(empty.usefulness).toBeNull();
    expect(empty.avgRunSeconds).toBeNull();
  });
});

describe("helpers", () => {
  it("counts human interventions but not automatic approvals", () => {
    expect(interventionsOf(ticket({ questions: [QUESTION], permissions: [PERMISSION, { ...PERMISSION, id: "p2", auto: true }] }))).toBe(2);
  });

  it("formats durations", () => {
    expect(formatDuration(38)).toBe("38 s");
    expect(formatDuration(260)).toBe("4 min 20 s");
    expect(formatDuration(3900)).toBe("1 h 05 min");
  });
});
