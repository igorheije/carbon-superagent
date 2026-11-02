import { clipSummary, isRecord, parseJsonLine, str } from "../executors/events";

/** Events sent to the browser while a draft is being written (NDJSON, one per line). */
export type DraftEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "reset" }
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "final"; readonly text: string }
  | { readonly type: "error"; readonly message: string };

const STATUS_FOR_TOOL: Readonly<Record<string, string>> = { Read: "lendo", Grep: "buscando", Glob: "listando" };

/**
 * Claude `--include-partial-messages` lines → draft events. A new assistant message resets the
 * buffer, so narration before a tool call never ends up in the description field.
 */
export function parseClaudeDraftLine(line: string): readonly DraftEvent[] {
  const json = parseJsonLine(line);
  if (!json) return [];
  const type = str(json.type);
  if (type === "stream_event" && isRecord(json.event)) {
    const event = json.event;
    if (str(event.type) === "message_start") return [{ type: "reset" }];
    if (str(event.type) === "content_block_delta" && isRecord(event.delta) && str(event.delta.type) === "text_delta") {
      const text = str(event.delta.text);
      return text ? [{ type: "delta", text }] : [];
    }
    return [];
  }
  if (type === "assistant" && isRecord(json.message) && Array.isArray(json.message.content)) {
    return json.message.content.filter(isRecord).flatMap((block): DraftEvent[] => {
      if (str(block.type) !== "tool_use") return [];
      const input = isRecord(block.input) ? block.input : {};
      const target = str(input.file_path) || str(input.pattern) || str(input.path);
      return [{ type: "status", text: clipSummary(`${STATUS_FOR_TOOL[str(block.name)] ?? str(block.name)} ${target}`) }];
    });
  }
  if (type === "result") {
    const isError = json.is_error === true || str(json.subtype) !== "success";
    return isError ? [{ type: "error", message: clipSummary(str(json.result) || "o agente não conseguiu gerar") }] : [{ type: "final", text: str(json.result) }];
  }
  return [];
}

/** Codex has no partial messages: show tool activity, then the last agent message. */
export function parseCodexDraftLine(line: string): readonly DraftEvent[] {
  const json = parseJsonLine(line);
  if (!json || str(json.type) !== "item.completed" || !isRecord(json.item)) return [];
  const item = json.item;
  if (str(item.type) === "agent_message") return [{ type: "final", text: str(item.text) }];
  if (str(item.type) === "command_execution") return [{ type: "status", text: clipSummary(`rodando ${str(item.command)}`) }];
  return [];
}

/** Keeps only the markdown document if the model added a preface before "## Contexto". */
export function cleanDraft(text: string): string {
  const start = text.indexOf("## Contexto");
  return (start > 0 ? text.slice(start) : text).trim();
}
