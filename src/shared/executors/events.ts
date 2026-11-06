/**
 * Normalized executor events. Claude Code (stream-json) and Codex (exec --json)
 * are both mapped into this shape so the runner is agent-agnostic.
 */
export type ExecutorEvent =
  | { readonly type: "session"; readonly sessionId: string; readonly model: string | null }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  /** `agentId` is set when a sub-agent (not the main agent) used the tool: the id of the call that started it. */
  | { readonly type: "tool"; readonly name: string; readonly summary: string; readonly path: string | null; readonly agentId?: string }
  /** The main agent delegated work to a sub-agent (Claude Code Agent/Task tool). */
  | { readonly type: "subagent_start"; readonly id: string; readonly description: string; readonly agentType: string; readonly isBackground: boolean }
  /** Progress reported by Claude Code for a running sub-agent (system task_progress). */
  | { readonly type: "subagent_progress"; readonly id: string; readonly toolCalls: number; readonly lastTool: string }
  /** A sub-agent finished (system task_notification). */
  | { readonly type: "subagent_end"; readonly id: string; readonly isError: boolean }
  /** A main-agent tool call returned synchronously; ends a sub-agent on CLIs without task events. */
  | { readonly type: "tool_done"; readonly toolUseId: string; readonly isError: boolean }
  | { readonly type: "plan"; readonly items: readonly { readonly text: string; readonly done: boolean }[] }
  | { readonly type: "usage"; readonly tokens: number; readonly costUsd: number | null }
  | { readonly type: "result"; readonly isError: boolean; readonly text: string }
  | { readonly type: "error"; readonly message: string }
  | {
      readonly type: "permission_request";
      readonly requestId: string;
      readonly tool: string;
      readonly summary: string;
      readonly detail: string;
      readonly input: unknown;
      readonly suggestions: readonly unknown[];
    }
  | { readonly type: "permission_denied"; readonly tool: string; readonly message: string };

const MAX_SUMMARY = 160;

export function clipSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_SUMMARY ? `${oneLine.slice(0, MAX_SUMMARY - 1)}…` : oneLine;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Parses one JSON line; returns null for blank or non-JSON lines (CLIs may print banners). */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
