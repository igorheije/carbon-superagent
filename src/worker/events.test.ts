import { describe, expect, it } from "vitest";
import type { ExecutorEvent } from "../shared/executors/events";
import { executorEventSchema, type RunSettings } from "../shared/worker-protocol";
import { clipEvent, clipText, relativize, TEXT_LIMIT } from "./events";
import { answerPermission } from "./permissions";

describe("clipEvent", () => {
  it("cuts oversized fields so every event passes the protocol schema", () => {
    const huge = "é".repeat(TEXT_LIMIT + 10);
    const events: ExecutorEvent[] = [
      { type: "text", text: huge },
      { type: "thinking", text: huge },
      { type: "tool", name: "n".repeat(500), summary: huge, path: "p".repeat(3000) },
      { type: "plan", items: Array.from({ length: 250 }, () => ({ text: huge, done: false })) },
      { type: "usage", tokens: Number.NaN, costUsd: -1 },
      { type: "result", isError: false, text: huge },
      { type: "error", message: huge },
      { type: "session", sessionId: "s".repeat(300), model: "m".repeat(300) },
      { type: "permission_request", requestId: "r", tool: "Bash", summary: huge, detail: huge, input: {}, suggestions: Array.from({ length: 60 }, () => ({})) },
      { type: "permission_denied", tool: "Bash", message: huge },
    ];
    for (const event of events) {
      expect(executorEventSchema.safeParse(event).success).toBe(false);
      expect(executorEventSchema.safeParse(clipEvent(event)).success).toBe(true);
    }
  });

  it("leaves small events untouched and does not mutate the input", () => {
    const event: ExecutorEvent = { type: "text", text: "oi" };
    expect(clipEvent(event)).toEqual(event);
    const big: ExecutorEvent = { type: "text", text: "x".repeat(TEXT_LIMIT + 1) };
    clipEvent(big);
    expect(big.text).toHaveLength(TEXT_LIMIT + 1);
    expect(clipText("abc", 10)).toBe("abc");
  });

  it("relativize strips the clone root from tool events", () => {
    expect(relativize({ type: "tool", name: "Edit", summary: "/w/task-1/src/a.ts", path: "/w/task-1/src/a.ts" }, "/w/task-1")).toEqual({
      type: "tool", name: "Edit", summary: "src/a.ts", path: "src/a.ts",
    });
  });
});

describe("answerPermission", () => {
  const settings = (approvalPolicy: RunSettings["approvalPolicy"]): RunSettings => ({ permissionProfile: "guarded", isolateClaudeConfig: false, approvalPolicy });
  const request = (command: string): Extract<ExecutorEvent, { type: "permission_request" }> => ({
    type: "permission_request", requestId: "r1", tool: "Bash", summary: command, detail: command, input: { command }, suggestions: [],
  });

  it("allows what a repo rule covers, denies what needs a human", () => {
    const allowed = answerPermission(request("make lint"), "/w/c", settings("ask"), [{ tool: "Bash", pattern: "make lint" }]);
    expect(allowed.decision.behavior).toBe("allow");
    const denied = answerPermission(request("make lint"), "/w/c", settings("ask"), []);
    expect(denied.decision.behavior).toBe("deny");
    expect(denied.report.type).toBe("permission_denied");
  });

  it("autonomous policy allows, blocks always win", () => {
    expect(answerPermission(request("make lint"), "/w/c", settings("autonomous"), []).decision.behavior).toBe("allow");
    const blocked = answerPermission(request("rm -rf /"), "/w/c", settings("autonomous"), [{ tool: "Bash", pattern: "" }]);
    expect(blocked.decision.behavior).toBe("deny");
  });
});
