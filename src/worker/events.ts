import type { ExecutorEvent } from "../shared/executors/events";

/**
 * Executor events cut to the limits of `executorEventSchema` (shared/worker-protocol.ts) before
 * they are queued: the client rejects anything outside the schema, and one oversized text block
 * (a long file dump, a huge tool summary) must never stop the task's event stream.
 */

export const TEXT_LIMIT = 64_000;
const NAME_LIMIT = 200;
const PATH_LIMIT = 2_000;
const PLAN_ITEMS_LIMIT = 200;
const SUGGESTIONS_LIMIT = 50;
const CLIPPED = "… [cortado pelo worker]";

/** Keeps at most `max` UTF-16 units (what zod's .max() counts), marking the cut. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - CLIPPED.length))}${CLIPPED}`;
}

const clipName = (text: string) => clipText(text, NAME_LIMIT);
const clipBody = (text: string) => clipText(text, TEXT_LIMIT);
const finiteOrZero = (n: number) => (Number.isFinite(n) && n >= 0 ? n : 0);

/** Returns a schema-safe copy of the event (never mutates it). */
export function clipEvent(event: ExecutorEvent): ExecutorEvent {
  switch (event.type) {
    case "session":
      return { ...event, sessionId: clipName(event.sessionId), model: event.model === null ? null : clipName(event.model) };
    case "text":
    case "thinking":
      return { ...event, text: clipBody(event.text) };
    case "tool":
      return { ...event, name: clipName(event.name), summary: clipBody(event.summary), path: event.path === null ? null : clipText(event.path, PATH_LIMIT) };
    case "plan":
      return { ...event, items: event.items.slice(0, PLAN_ITEMS_LIMIT).map((item) => ({ text: clipBody(item.text), done: item.done })) };
    case "usage":
      return { ...event, tokens: finiteOrZero(event.tokens), costUsd: event.costUsd === null || !Number.isFinite(event.costUsd) || event.costUsd < 0 ? null : event.costUsd };
    case "result":
      return { ...event, text: clipBody(event.text) };
    case "error":
      return { ...event, message: clipBody(event.message) };
    case "permission_request":
      return {
        ...event,
        requestId: clipName(event.requestId),
        tool: clipName(event.tool),
        summary: clipBody(event.summary),
        detail: clipBody(event.detail),
        suggestions: event.suggestions.slice(0, SUGGESTIONS_LIMIT),
      };
    case "permission_denied":
      return { ...event, tool: clipName(event.tool), message: clipBody(event.message) };
  }
}

/** Replaces absolute clone paths in tool events with repo-relative ones (same as the local runner). */
export function relativize(event: ExecutorEvent, root: string): ExecutorEvent {
  if (event.type !== "tool") return event;
  const strip = (text: string) => text.split(`${root}/`).join("").split(root).join(".");
  return { ...event, summary: strip(event.summary), path: event.path ? strip(event.path) : null };
}
