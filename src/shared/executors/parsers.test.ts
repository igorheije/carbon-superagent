import { describe, expect, it } from "vitest";
import { parseClaudeLine } from "./claude-parse";
import { parseCodexLine } from "./codex-parse";
import { parseMarkers, stripMarkers } from "./protocol";

describe("parseMarkers", () => {
  it("extracts every supported marker in order", () => {
    const text = [
      "Vou começar.",
      "CARBON_STAGE: plan",
      "CARBON_PLAN: mapear middleware",
      "CARBON_DONE: 1",
      "CARBON_TESTS: 213/214",
      "CARBON_FINDING: HIGH | chave expõe e-mail [resolved]",
      "CARBON_LESSON: isolar store por teste | falha intermitente",
      "CARBON_QUESTION: usar Redis ou memória?",
    ].join("\n");
    expect(parseMarkers(text)).toEqual([
      { kind: "stage", stage: "plan" },
      { kind: "plan", text: "mapear middleware" },
      { kind: "done", stepIndex: 0 },
      { kind: "tests", passing: 213, total: 214 },
      { kind: "finding", finding: { severity: "HIGH", text: "chave expõe e-mail", resolved: true } },
      { kind: "lesson", rule: "isolar store por teste", evidence: "falha intermitente" },
      { kind: "question", text: "usar Redis ou memória?" },
    ]);
  });

  it("accepts markers wrapped in markdown bullets, bold or inline code", () => {
    const text = ["- CARBON_PLAN: passo a", "1. `CARBON_PLAN: passo b`", "**CARBON_STAGE:** code", "> CARBON_DONE: 1"].join("\n");
    expect(parseMarkers(text)).toEqual([
      { kind: "plan", text: "passo a" },
      { kind: "plan", text: "passo b" },
      { kind: "stage", stage: "code" },
      { kind: "done", stepIndex: 0 },
    ]);
  });

  it("rejects malformed markers", () => {
    expect(parseMarkers("CARBON_STAGE: deploy\nCARBON_DONE: 0\nCARBON_TESTS: 5/3\nCARBON_FINDING: URGENT | x")).toEqual([]);
  });

  it("strips marker lines from human text", () => {
    expect(stripMarkers("ok\nCARBON_STAGE: code\nfeito")).toBe("ok\nfeito");
  });
});

describe("parseClaudeLine", () => {
  it("maps init, text, tool_use and result", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "opus" }))).toEqual([
      { type: "session", sessionId: "s1", model: "opus" },
    ]);
    const assistant = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "CARBON_STAGE: plan" },
          { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
      },
    };
    expect(parseClaudeLine(JSON.stringify(assistant))).toEqual([
      { type: "text", text: "CARBON_STAGE: plan" },
      { type: "tool", name: "Read", summary: "src/a.ts", path: "src/a.ts" },
      { type: "tool", name: "Bash", summary: "npm test", path: null },
    ]);
    const result = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 5 }, result: "ok" };
    expect(parseClaudeLine(JSON.stringify(result))).toEqual([
      { type: "usage", tokens: 15, costUsd: 0.12 },
      { type: "result", isError: false, text: "ok" },
    ]);
  });

  it("maps TodoWrite into a plan event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] } }] },
    });
    expect(parseClaudeLine(line)[1]).toEqual({ type: "plan", items: [{ text: "a", done: true }, { text: "b", done: false }] });
  });

  it("ignores banners and unknown events", () => {
    expect(parseClaudeLine("Welcome!")).toEqual([]);
    expect(parseClaudeLine(JSON.stringify({ type: "rate_limit_event" }))).toEqual([]);
  });
});

describe("parseCodexLine", () => {
  it("maps thread, messages, commands, file changes and usage", () => {
    expect(parseCodexLine(JSON.stringify({ type: "thread.started", thread_id: "t1" }))).toEqual([{ type: "session", sessionId: "t1", model: null }]);
    expect(parseCodexLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "CARBON_STAGE: code" } }))).toEqual([
      { type: "text", text: "CARBON_STAGE: code" },
    ]);
    expect(parseCodexLine(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test" } }))).toEqual([
      { type: "tool", name: "shell", summary: "npm test", path: null },
    ]);
    expect(parseCodexLine(JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.ts", kind: "update" }] } }))).toEqual([
      { type: "tool", name: "file_update", summary: "a.ts", path: "a.ts" },
    ]);
    expect(parseCodexLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } }))).toEqual([
      { type: "usage", tokens: 10, costUsd: null },
    ]);
  });

  it("surfaces turn failures as errors", () => {
    expect(parseCodexLine(JSON.stringify({ type: "turn.failed", error: { message: "boom" } }))).toEqual([{ type: "error", message: "boom" }]);
  });
});

describe("parseClaudeLine permission events", () => {
  it("maps a can_use_tool control request to a permission_request", () => {
    const line = JSON.stringify({
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm install left-pad" }, description: "Install a dependency", permission_suggestions: [{ type: "setMode", mode: "acceptEdits" }] },
    });
    expect(parseClaudeLine(line)).toEqual([
      { type: "permission_request", requestId: "req-1", tool: "Bash", summary: "Install a dependency", detail: "npm install left-pad", input: { command: "npm install left-pad" }, suggestions: [{ type: "setMode", mode: "acceptEdits" }] },
    ]);
  });

  it("maps system permission_denied", () => {
    const line = JSON.stringify({ type: "system", subtype: "permission_denied", tool_name: "Write", message: "not granted" });
    expect(parseClaudeLine(line)).toEqual([{ type: "permission_denied", tool: "Write", message: "not granted" }]);
  });
});
