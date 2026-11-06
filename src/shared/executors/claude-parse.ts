import { clipSummary, isRecord, num, parseJsonLine, str, type ExecutorEvent } from "./events";

const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

function toolSummary(name: string, input: Record<string, unknown>): { summary: string; path: string | null } {
  const path = PATH_KEYS.map((k) => str(input[k])).find(Boolean) ?? null;
  if (name === "Bash") return { summary: clipSummary(str(input.command)), path: null };
  if (name === "Grep" || name === "Glob") return { summary: clipSummary(`${str(input.pattern)} ${str(input.path)}`), path: null };
  if (name === "TodoWrite") return { summary: "atualizou lista de tarefas", path: null };
  return { summary: path ?? clipSummary(JSON.stringify(input)), path };
}

function todoItems(input: Record<string, unknown>): ExecutorEvent | null {
  const todos = input.todos;
  if (!Array.isArray(todos)) return null;
  const items = todos.filter(isRecord).map((t) => ({ text: str(t.content), done: str(t.status) === "completed" }));
  return items.length ? { type: "plan", items } : null;
}

/** Claude Code's delegation tool: "Agent" in current versions, "Task" in older ones. */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

function subagentStart(id: string, input: Record<string, unknown>): ExecutorEvent {
  return {
    type: "subagent_start",
    id,
    description: clipSummary(str(input.description) || str(input.prompt) || "sub-agente"),
    agentType: str(input.subagent_type) || "general-purpose",
    isBackground: input.run_in_background === true,
  };
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(message.content) ? message.content.filter(isRecord) : [];
}

/** Main agent: narration, thinking, tools, plan and delegations. */
function assistantEvents(message: Record<string, unknown>): ExecutorEvent[] {
  return contentBlocks(message).flatMap((block): ExecutorEvent[] => {
    const kind = str(block.type);
    if (kind === "text" && str(block.text)) return [{ type: "text", text: str(block.text) }];
    if (kind === "thinking" && str(block.thinking)) return [{ type: "thinking", text: str(block.thinking) }];
    if (kind === "tool_use") {
      const name = str(block.name);
      const input = isRecord(block.input) ? block.input : {};
      if (SUBAGENT_TOOLS.has(name) && str(block.id)) return [subagentStart(str(block.id), input)];
      const plan = name === "TodoWrite" ? todoItems(input) : null;
      return [{ type: "tool", name, ...toolSummary(name, input) }, ...(plan ? [plan] : [])];
    }
    return [];
  });
}

/**
 * Sub-agent messages: only tool use, tagged with the sub-agent. Their text is never parsed for
 * Carbon markers, so a sub-agent cannot move the pipeline, ask questions or record lessons.
 */
function subagentEvents(message: Record<string, unknown>, agentId: string): ExecutorEvent[] {
  return contentBlocks(message)
    .filter((block) => str(block.type) === "tool_use")
    .map((block): ExecutorEvent => {
      const name = str(block.name);
      const input = isRecord(block.input) ? block.input : {};
      return { type: "tool", name, ...toolSummary(name, input), agentId };
    });
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(isRecord).map((c) => str(c.text)).join(" ") : "";
}

/**
 * Tool results of the main agent; the runner only cares about the ones that end a sub-agent.
 * An async launch ("Async agent launched…") returns at once: its end comes as task_notification.
 */
function toolResults(message: Record<string, unknown>): ExecutorEvent[] {
  return contentBlocks(message)
    .filter((block) => str(block.type) === "tool_result" && str(block.tool_use_id))
    .filter((block) => !/^\s*async agent launched/i.test(resultText(block.content)))
    .map((block) => ({ type: "tool_done", toolUseId: str(block.tool_use_id), isError: block.is_error === true }));
}

const AGENT_TASK_TYPES = new Set(["local_agent", "remote_agent"]);
const OK_TASK_STATUSES = new Set(["completed", "success"]);

/** Claude Code's background-task events (current versions run sub-agents this way). */
function taskEvents(json: Record<string, unknown>): ExecutorEvent[] {
  const subtype = str(json.subtype);
  const id = str(json.tool_use_id);
  if (!id) return [];
  if (subtype === "task_started") {
    if (str(json.task_type) && !AGENT_TASK_TYPES.has(str(json.task_type))) return [];
    return [{
      type: "subagent_start",
      id,
      description: clipSummary(str(json.description) || "sub-agente"),
      agentType: str(json.subagent_type) || "general-purpose",
      isBackground: json.is_backgrounded === true,
    }];
  }
  if (subtype === "task_progress") {
    const usage = isRecord(json.usage) ? json.usage : {};
    return [{ type: "subagent_progress", id, toolCalls: num(usage.tool_uses), lastTool: str(json.last_tool_name) }];
  }
  if (subtype === "task_notification") return [{ type: "subagent_end", id, isError: !OK_TASK_STATUSES.has(str(json.status)) }];
  return [];
}

function usageTokens(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  return num(usage.input_tokens) + num(usage.output_tokens) + num(usage.cache_creation_input_tokens);
}

const MAX_DETAIL = 1200;

function permissionDetail(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash") return str(input.command);
  if (tool === "Write") return `${str(input.file_path)}\n\n${str(input.content).slice(0, MAX_DETAIL)}`;
  if (tool === "Edit" || tool === "MultiEdit") return `${str(input.file_path)}\n- ${str(input.old_string).slice(0, 400)}\n+ ${str(input.new_string).slice(0, 400)}`;
  if (tool === "WebFetch") return str(input.url);
  return JSON.stringify(input).slice(0, MAX_DETAIL);
}

/**
 * Summary and detail of a permission prompt computed from its raw input only (no free-form
 * description). The panel uses it for prompts forwarded by workers, so what a human approves is
 * derived from the same input the rule pattern is computed from.
 */
export function describePermission(tool: string, input: unknown): { readonly summary: string; readonly detail: string } {
  const data = isRecord(input) ? input : {};
  return { summary: clipSummary(toolSummary(tool, data).summary), detail: permissionDetail(tool, data) };
}

/** Maps one line of `claude -p --output-format stream-json --verbose` to normalized events. */
export function parseClaudeLine(line: string): readonly ExecutorEvent[] {
  const json = parseJsonLine(line);
  if (!json) return [];
  const type = str(json.type);

  if (type === "control_request" && isRecord(json.request) && str(json.request.subtype) === "can_use_tool") {
    const req = json.request;
    const tool = str(req.tool_name) || "ferramenta";
    const input = isRecord(req.input) ? req.input : {};
    return [{
      type: "permission_request",
      requestId: str(json.request_id),
      tool,
      summary: clipSummary(str(req.description) || toolSummary(tool, input).summary),
      detail: permissionDetail(tool, input),
      input: req.input ?? {},
      suggestions: Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [],
    }];
  }
  if (type === "system" && str(json.subtype) === "permission_denied") {
    return [{ type: "permission_denied", tool: str(json.tool_name), message: str(json.message) }];
  }
  if (type === "system" && str(json.subtype) === "init") {
    return [{ type: "session", sessionId: str(json.session_id), model: str(json.model) || null }];
  }
  if (type === "system" && str(json.subtype).startsWith("task_")) return taskEvents(json);
  const parentId = str(json.parent_tool_use_id);
  if (type === "assistant" && isRecord(json.message)) return parentId ? subagentEvents(json.message, parentId) : assistantEvents(json.message);
  if (type === "user" && isRecord(json.message) && !parentId) return toolResults(json.message);
  if (type === "result") {
    const cost = typeof json.total_cost_usd === "number" ? json.total_cost_usd : null;
    return [
      { type: "usage", tokens: usageTokens(json.usage), costUsd: cost },
      { type: "result", isError: json.is_error === true || str(json.subtype) !== "success", text: str(json.result) },
    ];
  }
  return [];
}
