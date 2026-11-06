import { describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import { parseClaudeLine } from "../executors/claude-parse";
import type { ExecutorEvent } from "../executors/events";
import { applyExecutorEvent, emptyContext, type RunContext } from "./apply";
import { buildPrompt } from "./prompt";
import { closeRunningSubagents, MAX_SUBAGENTS, startSubagent } from "./subagents";

const base: Ticket = {
  id: "t",
  key: "FRG-1",
  title: "x",
  source: "github",
  repo: "r",
  requester: "ana",
  priority: "medium",
  status: "running",
  stage: "code",
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

const line = (obj: unknown) => JSON.stringify(obj);
const agentCall = (id: string, input: Record<string, unknown>, name = "Agent") =>
  line({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name, input }] } });
const subTool = (parent: string, name: string, input: Record<string, unknown>) =>
  line({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id: "x", name, input }] } });
const toolResult = (id: string, isError = false) =>
  line({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }] } });

function fold(lines: readonly string[], ticket: Ticket = base): { ticket: Ticket; ctx: RunContext } {
  return lines.flatMap(parseClaudeLine).reduce((s, e: ExecutorEvent) => applyExecutorEvent(s.ticket, s.ctx, e), { ticket, ctx: emptyContext });
}

describe("parseClaudeLine · sub-agents", () => {
  it("turns an Agent (or legacy Task) call into a sub-agent start", () => {
    expect(parseClaudeLine(agentCall("toolu_1", { description: "Escrever testes", subagent_type: "tester", prompt: "..." }))).toEqual([
      { type: "subagent_start", id: "toolu_1", description: "Escrever testes", agentType: "tester", isBackground: false },
    ]);
    expect(parseClaudeLine(agentCall("toolu_2", { prompt: "pesquisar" }, "Task"))[0]).toMatchObject({ type: "subagent_start", agentType: "general-purpose", description: "pesquisar" });
  });

  it("tags sub-agent tool use and drops sub-agent text so it cannot emit Carbon markers", () => {
    const text = line({ type: "assistant", parent_tool_use_id: "toolu_1", message: { content: [{ type: "text", text: "CARBON_STAGE: deliver" }] } });
    expect(parseClaudeLine(text)).toEqual([]);
    expect(parseClaudeLine(subTool("toolu_1", "Read", { file_path: "src/a.ts" }))).toEqual([
      { type: "tool", name: "Read", summary: "src/a.ts", path: "src/a.ts", agentId: "toolu_1" },
    ]);
  });

  it("reports main-level tool results and ignores the sub-agents' own results", () => {
    expect(parseClaudeLine(toolResult("toolu_1", true))).toEqual([{ type: "tool_done", toolUseId: "toolu_1", isError: true }]);
    const nested = line({ type: "user", parent_tool_use_id: "toolu_1", message: { content: [{ type: "tool_result", tool_use_id: "y" }] } });
    expect(parseClaudeLine(nested)).toEqual([]);
  });
});

describe("sub-agent lifecycle on the ticket", () => {
  it("tracks start, activity and end of parallel sub-agents", () => {
    const { ticket } = fold([
      agentCall("a1", { description: "API", subagent_type: "coder" }),
      agentCall("a2", { description: "Testes" }),
      subTool("a1", "Edit", { file_path: "src/api.ts" }),
      subTool("a1", "Read", { file_path: "src/db.ts" }),
      toolResult("a1"),
    ]);

    expect(ticket.subagents?.map((a) => [a.id, a.status, a.toolCalls])).toEqual([["a1", "done", 2], ["a2", "running", 0]]);
    expect(ticket.subagents?.[0]?.lastActivity).toBe("Read src/db.ts");
    expect(ticket.logs.map((l) => l.text)).toContain("⟁ sub-agente coder: API");
    expect(ticket.logs.map((l) => l.text)).toContain("sub-agente concluiu: API");
  });

  it("does not let a sub-agent's reads change the knowledge hits of the main agent", () => {
    const { ticket } = fold([agentCall("a1", { description: "x" }), subTool("a1", "Read", { file_path: "src/a.ts" })]);
    expect(ticket.hits).toEqual([]);
  });

  it("marks a failed sub-agent and leaves unrelated tool results alone", () => {
    const { ticket } = fold([agentCall("a1", { description: "x" }), toolResult("other"), toolResult("a1", true)]);
    expect(ticket.subagents?.[0]?.status).toBe("failed");
    expect(ticket.logs.at(-1)?.level).toBe("warn");
  });

  it("keeps background sub-agents running until the run ends", () => {
    const started = fold([agentCall("bg", { description: "x", run_in_background: true }), toolResult("bg")]);
    expect(started.ticket.subagents?.[0]?.status).toBe("running");

    const ended = fold([line({ type: "result", subtype: "success", is_error: false, result: "fim", usage: {} })], started.ticket);
    expect(ended.ticket.subagents?.[0]).toMatchObject({ status: "done" });
    expect(ended.ticket.subagents?.[0]?.endedAt).not.toBeNull();
  });

  it("ignores a duplicate start and caps how many sub-agents are kept", () => {
    const once = startSubagent(base, { id: "a", description: "x", agentType: "t", isBackground: false }, "now");
    expect(startSubagent(once, { id: "a", description: "y", agentType: "t", isBackground: false }, "now")).toBe(once);

    const many = Array.from({ length: MAX_SUBAGENTS + 5 }, (_, i) => i).reduce(
      (t, i) => startSubagent(t, { id: `s${i}`, description: "x", agentType: "t", isBackground: false }, "now"),
      base,
    );
    expect(many.subagents).toHaveLength(MAX_SUBAGENTS);
    expect(many.subagents?.[0]?.id).toBe("s5");
  });

  it("closes whatever is still running when the task stops", () => {
    const running = startSubagent(base, { id: "a", description: "x", agentType: "t", isBackground: false }, "t0");
    expect(closeRunningSubagents(running, "failed", "t1").subagents?.[0]).toMatchObject({ status: "failed", endedAt: "t1" });
    expect(closeRunningSubagents(base, "done", "t1")).toBe(base);
  });
});

/** Shape captured from Claude Code 2.x, where the Agent tool runs sub-agents as background tasks. */
describe("async sub-agents (system task_* events)", () => {
  const sys = (subtype: string, extra: Record<string, unknown>) => line({ type: "system", subtype, task_id: "ae09", run_id: "r1", ...extra });
  const asyncLaunch = (id: string) =>
    line({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "Async agent launched successfully. (internal metadata)" }] }] } });

  it("parses task_started, task_progress and task_notification", () => {
    expect(parseClaudeLine(sys("task_started", { tool_use_id: "a1", description: "probe", subagent_type: "general-purpose", is_backgrounded: true, task_type: "local_agent" }))).toEqual([
      { type: "subagent_start", id: "a1", description: "probe", agentType: "general-purpose", isBackground: true },
    ]);
    expect(parseClaudeLine(sys("task_progress", { tool_use_id: "a1", usage: { tool_uses: 2 }, last_tool_name: "Bash" }))).toEqual([
      { type: "subagent_progress", id: "a1", toolCalls: 2, lastTool: "Bash" },
    ]);
    expect(parseClaudeLine(sys("task_notification", { tool_use_id: "a1", status: "completed" }))).toEqual([{ type: "subagent_end", id: "a1", isError: false }]);
    expect(parseClaudeLine(sys("task_notification", { tool_use_id: "a1", status: "failed" }))).toEqual([{ type: "subagent_end", id: "a1", isError: true }]);
    expect(parseClaudeLine(sys("task_started", { tool_use_id: "b1", task_type: "local_bash" }))).toEqual([]);
    expect(parseClaudeLine(asyncLaunch("a1"))).toEqual([]);
  });

  it("keeps the sub-agent running after the async launch and ends it on task_notification", () => {
    const launched = fold([
      agentCall("a1", { description: "probe", subagent_type: "general-purpose", prompt: "..." }),
      sys("task_started", { tool_use_id: "a1", description: "probe", subagent_type: "general-purpose", is_backgrounded: true, task_type: "local_agent" }),
      asyncLaunch("a1"),
      subTool("a1", "Bash", { command: "ls -la" }),
      sys("task_progress", { tool_use_id: "a1", usage: { tool_uses: 2 }, last_tool_name: "Bash" }),
    ]);
    expect(launched.ticket.subagents).toHaveLength(1);
    expect(launched.ticket.subagents?.[0]).toMatchObject({ status: "running", toolCalls: 2, lastActivity: "Bash ls -la" });

    const ended = fold([sys("task_notification", { tool_use_id: "a1", status: "completed" })], launched.ticket);
    expect(ended.ticket.subagents?.[0]?.status).toBe("done");
    expect(ended.ticket.logs.at(-1)?.text).toBe("sub-agente concluiu: probe");
  });

  it("treats a background tool_result as no end even when the launch text is missing", () => {
    const { ticket } = fold([
      sys("task_started", { tool_use_id: "a1", description: "x", is_backgrounded: true, task_type: "local_agent" }),
      toolResult("a1"),
    ]);
    expect(ticket.subagents?.[0]?.status).toBe("running");
  });
});

describe("buildPrompt · multi-agent", () => {
  const input = { key: "FRG-1", title: "t", description: "d", persona: "engineering" as const, requester: "ana", skills: [], lessons: [], knowledge: null };

  it("adds the delegation rules only for Claude Code tasks that allowed it", () => {
    expect(buildPrompt({ ...input, executor: "claude", multiAgent: true })).toContain("## Multi-agent mode");
    expect(buildPrompt({ ...input, executor: "claude", multiAgent: false })).not.toContain("## Multi-agent mode");
    expect(buildPrompt({ ...input, executor: "codex", multiAgent: true })).not.toContain("## Multi-agent mode");
  });
});
