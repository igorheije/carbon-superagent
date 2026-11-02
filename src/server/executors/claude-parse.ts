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

function assistantEvents(message: Record<string, unknown>): ExecutorEvent[] {
  const content = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
  return content.flatMap((block): ExecutorEvent[] => {
    const kind = str(block.type);
    if (kind === "text" && str(block.text)) return [{ type: "text", text: str(block.text) }];
    if (kind === "thinking" && str(block.thinking)) return [{ type: "thinking", text: str(block.thinking) }];
    if (kind === "tool_use") {
      const name = str(block.name);
      const input = isRecord(block.input) ? block.input : {};
      const plan = name === "TodoWrite" ? todoItems(input) : null;
      return [{ type: "tool", name, ...toolSummary(name, input) }, ...(plan ? [plan] : [])];
    }
    return [];
  });
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
  if (type === "assistant" && isRecord(json.message)) return assistantEvents(json.message);
  if (type === "result") {
    const cost = typeof json.total_cost_usd === "number" ? json.total_cost_usd : null;
    return [
      { type: "usage", tokens: usageTokens(json.usage), costUsd: cost },
      { type: "result", isError: json.is_error === true || str(json.subtype) !== "success", text: str(json.result) },
    ];
  }
  return [];
}
