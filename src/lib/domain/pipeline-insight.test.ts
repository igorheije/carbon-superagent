import { describe, expect, it } from "vitest";
import { pipelineProgress, stageInsight } from "./pipeline-insight";
import type { Ticket } from "./types";

const ticket: Ticket = {
  id: "t",
  key: "FRG-9",
  title: "x",
  source: "github",
  repo: "api",
  requester: "ana",
  priority: "medium",
  status: "running",
  stage: "test",
  cursor: 0,
  totalEvents: 0,
  plan: [
    { id: "p1", text: "mapear", done: true },
    { id: "p2", text: "implementar", done: false },
  ],
  logs: [
    { id: 1, stage: "plan", level: "info", text: "planejando" },
    { id: 2, stage: "test", level: "tool", text: "npm test" },
    { id: 3, stage: "test", level: "warn", text: "1 falhou" },
  ],
  hits: [{ id: "h", kind: "code", ref: "src/a.ts", score: 0.91, excerpt: "" }],
  diff: [{ path: "src/a.ts", additions: 4, deletions: 1, snippet: [] }],
  findings: [{ severity: "HIGH", text: "vaza pii", resolved: true }],
  tests: { added: 2, passing: 9, total: 10 },
  pr: { number: 12, branch: "agent/frg-9", draft: true },
  tokens: 0,
  model: "opus · high",
  startedAtTick: null,
  endedAtTick: null,
};

describe("stageInsight", () => {
  it("counts the logs, tool calls and warnings of one stage", () => {
    expect(stageInsight(ticket, "test")).toMatchObject({ events: 2, tools: 1, warnings: 1, highlights: ["9/10 testes passando"] });
  });

  it("builds stage-specific highlights", () => {
    expect(stageInsight(ticket, "plan").highlights).toEqual(["✓ mapear", "○ implementar"]);
    expect(stageInsight(ticket, "research").highlights).toEqual(["src/a.ts · 0.91"]);
    expect(stageInsight(ticket, "review").highlights).toEqual(["✓ HIGH · vaza pii"]);
    expect(stageInsight(ticket, "deliver").highlights).toEqual(["PR #12 (draft) · agent/frg-9 → base", "src/a.ts +4 −1"]);
    const withWorkspace = { ...ticket, workspace: { path: "/wt", branch: "agent/frg-9", base: "origin/main", prBase: "main", commit: "a1b2c3d" }, pr: { ...ticket.pr!, base: "develop" } };
    expect(stageInsight(withWorkspace, "deliver").highlights.slice(0, 2)).toEqual(["worktree agent/frg-9 ← origin/main · a1b2c3d", "PR #12 (draft) · agent/frg-9 → develop"]);
  });

  it("is empty without a ticket", () => {
    expect(stageInsight(null, "code")).toEqual({ logs: [], events: 0, tools: 0, warnings: 0, highlights: [] });
  });
});

describe("pipelineProgress", () => {
  it("counts done stages fully and the active one by half", () => {
    expect(pipelineProgress(["done", "done", "working", "idle"])).toBeCloseTo(0.625);
    expect(pipelineProgress([])).toBe(0);
  });
});
