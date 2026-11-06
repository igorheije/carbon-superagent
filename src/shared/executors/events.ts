/**
 * Normalized executor events. Claude Code (stream-json) and Codex (exec --json)
 * are both mapped into this shape so the runner is agent-agnostic.
 */
export type ExecutorEvent =
  | { readonly type: "session"; readonly sessionId: string; readonly model: string | null }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly summary: string; readonly path: string | null }
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
