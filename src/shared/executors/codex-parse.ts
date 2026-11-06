import { clipSummary, isRecord, num, parseJsonLine, str, type ExecutorEvent } from "./events";

/**
 * Maps one line of `codex exec --json` (thread/turn/item events) to normalized events.
 * Shapes follow the documented Codex exec JSONL format; unknown events are ignored
 * so newer CLI versions degrade gracefully instead of breaking the run.
 */
function itemEvents(item: Record<string, unknown>): ExecutorEvent[] {
  switch (str(item.type)) {
    case "agent_message":
      return str(item.text) ? [{ type: "text", text: str(item.text) }] : [];
    case "reasoning":
      return str(item.text) ? [{ type: "thinking", text: str(item.text) }] : [];
    case "command_execution":
      return [{ type: "tool", name: "shell", summary: clipSummary(str(item.command)), path: null }];
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
      return changes.map((c) => ({
        type: "tool" as const,
        name: `file_${str(c.kind) || "change"}`,
        summary: str(c.path),
        path: str(c.path) || null,
      }));
    }
    case "mcp_tool_call":
      return [{ type: "tool", name: `mcp:${str(item.server)}`, summary: str(item.tool), path: null }];
    case "web_search":
      return [{ type: "tool", name: "web_search", summary: clipSummary(str(item.query)), path: null }];
    case "todo_list": {
      const items = Array.isArray(item.items) ? item.items.filter(isRecord) : [];
      const plan = items.map((t) => ({ text: str(t.text), done: t.completed === true }));
      return plan.length ? [{ type: "plan", items: plan }] : [];
    }
    case "error":
      return [{ type: "error", message: str(item.message) }];
    default:
      return [];
  }
}

export function parseCodexLine(line: string): readonly ExecutorEvent[] {
  const json = parseJsonLine(line);
  if (!json) return [];
  const type = str(json.type);

  if (type === "thread.started") return [{ type: "session", sessionId: str(json.thread_id), model: null }];
  if (type === "item.completed" && isRecord(json.item)) return itemEvents(json.item);
  if (type === "item.updated" && isRecord(json.item) && str(json.item.type) === "todo_list") return itemEvents(json.item);
  if (type === "turn.completed" && isRecord(json.usage)) {
    const usage = json.usage;
    return [{ type: "usage", tokens: num(usage.input_tokens) + num(usage.output_tokens), costUsd: null }];
  }
  if (type === "turn.failed") {
    const error = isRecord(json.error) ? str(json.error.message) : "turn failed";
    return [{ type: "error", message: error }];
  }
  if (type === "error") return [{ type: "error", message: str(json.message) }];
  return [];
}
