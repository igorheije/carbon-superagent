import { STAGES, type StageId, type Ticket } from "@/lib/domain/types";
import { clipSummary, type ExecutorEvent } from "../executors/events";
import { parseMarkers, stripMarkers, type Marker } from "../executors/protocol";
import { addQuestion } from "./questions";
import { appendLog } from "./ticket-log";

export { appendLog, MAX_LOGS } from "./ticket-log";
const MAX_HITS = 12;
const MAX_NARRATION_LINES = 3;
const RESEARCH_TOOLS = new Set(["Read", "Grep", "Glob"]);

/** Side data collected during a run that does not live on the Ticket itself. */
export interface RunContext {
  readonly lessons: readonly { readonly rule: string; readonly evidence: string }[];
  readonly question: string | null;
  readonly hasMarkerPlan: boolean;
  readonly isError: boolean;
  readonly costUsd: number;
  readonly sessionId: string | null;
}

export const emptyContext: RunContext = { lessons: [], question: null, hasMarkerPlan: false, isError: false, costUsd: 0, sessionId: null };

const currentStage = (ticket: Ticket): StageId => ticket.stage ?? "intake";

/** Stages only move forward; a late marker for an earlier stage is ignored. */
function advanceStage(ticket: Ticket, stage: StageId): Ticket {
  const from = STAGES.indexOf(currentStage(ticket));
  return STAGES.indexOf(stage) > from ? { ...ticket, stage } : ticket;
}

function applyMarker(state: { ticket: Ticket; ctx: RunContext }, marker: Marker): { ticket: Ticket; ctx: RunContext } {
  const { ticket, ctx } = state;
  switch (marker.kind) {
    case "stage":
      return { ticket: advanceStage(ticket, marker.stage), ctx };
    case "plan": {
      const base = ctx.hasMarkerPlan ? ticket.plan : [];
      const step = { id: `${ticket.id}-p${base.length}`, text: marker.text, done: false };
      return { ticket: { ...ticket, plan: [...base, step] }, ctx: { ...ctx, hasMarkerPlan: true } };
    }
    case "done":
      return { ticket: { ...ticket, plan: ticket.plan.map((s, i) => (i === marker.stepIndex ? { id: s.id, text: s.text, done: true } : s)) }, ctx };
    case "skipped":
      return {
        ticket: { ...ticket, plan: ticket.plan.map((s, i) => (i === marker.stepIndex ? { ...s, done: false, state: "skipped" as const, note: marker.reason } : s)) },
        ctx,
      };
    case "tests":
      return { ticket: { ...ticket, tests: { added: ticket.tests?.added ?? 0, passing: marker.passing, total: marker.total } }, ctx };
    case "finding": {
      const existing = ticket.findings.findIndex((f) => f.text === marker.finding.text);
      const findings =
        existing === -1 ? [...ticket.findings, marker.finding] : ticket.findings.map((f, i) => (i === existing ? marker.finding : f));
      return { ticket: { ...ticket, findings }, ctx };
    }
    case "lesson":
      return { ticket, ctx: { ...ctx, lessons: [...ctx.lessons, { rule: marker.rule, evidence: marker.evidence }] } };
    case "question":
      return { ticket: addQuestion(ticket, currentStage(ticket), marker.text, new Date().toISOString()), ctx: { ...ctx, question: marker.text } };
  }
}

function applyText(ticket: Ticket, ctx: RunContext, text: string): { ticket: Ticket; ctx: RunContext } {
  const afterMarkers = parseMarkers(text).reduce(applyMarker, { ticket, ctx });
  const narration = stripMarkers(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_NARRATION_LINES);
  const withLogs = narration.reduce(
    (t, line) => appendLog(t, currentStage(t), "info", clipSummary(line)),
    afterMarkers.ticket,
  );
  return { ticket: withLogs, ctx: afterMarkers.ctx };
}

function addHit(ticket: Ticket, path: string): Ticket {
  if (ticket.hits.some((h) => h.ref === path) || ticket.hits.length >= MAX_HITS) return ticket;
  const hit = { id: `${ticket.id}-h${ticket.hits.length}`, kind: "code" as const, ref: path, score: 1, excerpt: "lido pelo agente" };
  return { ...ticket, hits: [...ticket.hits, hit] };
}

/** Pure reducer: folds one normalized executor event into the ticket and run context. */
export function applyExecutorEvent(ticket: Ticket, ctx: RunContext, event: ExecutorEvent): { ticket: Ticket; ctx: RunContext } {
  switch (event.type) {
    case "session":
      return {
        ticket: { ...appendLog(ticket, currentStage(ticket), "info", `sessão ${event.sessionId.slice(0, 8)}${event.model ? ` · ${event.model}` : ""}`), sessionId: event.sessionId },
        ctx: { ...ctx, sessionId: event.sessionId },
      };
    case "text":
      return applyText(ticket, ctx, event.text);
    case "thinking":
      return { ticket: appendLog(ticket, currentStage(ticket), "think", clipSummary(event.text)), ctx };
    case "tool": {
      const logged = appendLog(ticket, currentStage(ticket), "tool", `${event.name} ${event.summary}`.trim());
      const withHit = event.path && RESEARCH_TOOLS.has(event.name) ? addHit(logged, event.path) : logged;
      return { ticket: withHit, ctx };
    }
    case "plan":
      if (ctx.hasMarkerPlan) return { ticket, ctx };
      return { ticket: { ...ticket, plan: event.items.map((item, i) => ({ id: `${ticket.id}-t${i}`, text: item.text, done: item.done })) }, ctx };
    case "usage":
      return { ticket: { ...ticket, tokens: ticket.tokens + event.tokens }, ctx: { ...ctx, costUsd: ctx.costUsd + (event.costUsd ?? 0) } };
    case "result":
      return {
        ticket: event.isError ? appendLog(ticket, currentStage(ticket), "warn", `agente terminou com erro: ${clipSummary(event.text)}`) : ticket,
        ctx: { ...ctx, isError: ctx.isError || event.isError },
      };
    case "error":
      return { ticket: appendLog(ticket, currentStage(ticket), "warn", clipSummary(event.message)), ctx: { ...ctx, isError: true } };
    case "permission_request": {
      const prompt = {
        id: event.requestId,
        tool: event.tool,
        summary: event.summary,
        detail: event.detail,
        canRemember: event.suggestions.length > 0,
        status: "pending" as const,
        decidedBy: null,
        askedAt: new Date().toISOString(),
      };
      const logged = appendLog(ticket, currentStage(ticket), "warn", `permissão: ${event.tool} — ${event.summary}`);
      return { ticket: { ...logged, status: "waiting", permissions: [...(ticket.permissions ?? []), prompt] }, ctx };
    }
    case "permission_denied":
      return { ticket: appendLog(ticket, currentStage(ticket), "warn", `negado: ${event.tool} — ${clipSummary(event.message)}`), ctx };
  }
}

/**
 * End of a successful run: steps the agent never closed are marked "unconfirmed" — never
 * silently checked. Returns the updated ticket and how many steps were left open.
 */
export function reconcilePlan(ticket: Ticket): { ticket: Ticket; unconfirmed: number } {
  let unconfirmed = 0;
  const plan = ticket.plan.map((step) => {
    if (step.done || step.state === "skipped") return step;
    unconfirmed += 1;
    return { ...step, state: "unconfirmed" as const, note: "o agente não confirmou este passo" };
  });
  return { ticket: { ...ticket, plan }, unconfirmed };
}
