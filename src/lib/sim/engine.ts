import {
  STAGES,
  type AcceptMode,
  type AgentStatus,
  type EngineState,
  type StageId,
  type Ticket,
} from "@/lib/domain/types";
import { buildScript, type ScriptEvent, type TicketSpec } from "./script";

export type EngineAction =
  | { readonly type: "tick" }
  | { readonly type: "toggle" }
  | { readonly type: "setSpeed"; readonly speedMs: number }
  | { readonly type: "prioritize"; readonly ticketId: string }
  | { readonly type: "promote"; readonly lessonId: string }
  | { readonly type: "discard"; readonly lessonId: string }
  | { readonly type: "setAcceptMode"; readonly mode: AcceptMode }
  | { readonly type: "reset" };

export const MIN_SPEED_MS = 120;
export const MAX_SPEED_MS = 2000;
export const DEFAULT_SPEED_MS = 650;
const MAX_LOGS_PER_TICKET = 200;

export interface Engine {
  readonly initial: EngineState;
  readonly reduce: (state: EngineState, action: EngineAction) => EngineState;
}

function idleAgents(): Record<StageId, AgentStatus> {
  return Object.fromEntries(STAGES.map((stage) => [stage, "idle"])) as Record<StageId, AgentStatus>;
}

function agentsAt(stage: StageId): Record<StageId, AgentStatus> {
  const current = STAGES.indexOf(stage);
  return Object.fromEntries(
    STAGES.map((s, i) => [s, i < current ? "done" : i === current ? "working" : "idle"]),
  ) as Record<StageId, AgentStatus>;
}

function ticketFromSpec(spec: TicketSpec, totalEvents: number): Ticket {
  return {
    id: spec.id,
    key: spec.key,
    title: spec.title,
    source: spec.source,
    repo: spec.repo,
    requester: spec.requester,
    priority: spec.priority,
    status: "queued",
    stage: null,
    cursor: 0,
    totalEvents,
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
}

function applyEvent(
  state: EngineState,
  ticket: Ticket,
  event: ScriptEvent,
): { ticket: Ticket; state: EngineState } {
  switch (event.kind) {
    case "stage":
      return { ticket: { ...ticket, stage: event.stage }, state: { ...state, agents: agentsAt(event.stage) } };
    case "log": {
      const line = { id: state.nextLogId, stage: event.stage, level: event.level, text: event.text };
      const logs = [...ticket.logs, line].slice(-MAX_LOGS_PER_TICKET);
      return { ticket: { ...ticket, logs }, state: { ...state, nextLogId: state.nextLogId + 1 } };
    }
    case "plan":
      return {
        ticket: { ...ticket, plan: event.steps.map((text, i) => ({ id: `${ticket.id}-s${i}`, text, done: false })) },
        state,
      };
    case "check":
      return {
        ticket: { ...ticket, plan: ticket.plan.map((step, i) => (i === event.stepIndex ? { ...step, done: true } : step)) },
        state,
      };
    case "hit":
      return { ticket: { ...ticket, hits: [...ticket.hits, event.hit] }, state };
    case "diff":
      return { ticket: { ...ticket, diff: [...ticket.diff, event.file] }, state };
    case "tests":
      return { ticket: { ...ticket, tests: { added: event.added, passing: event.passing, total: event.total } }, state };
    case "finding":
      return { ticket: { ...ticket, findings: [...ticket.findings, event.finding] }, state };
    case "resolve":
      return {
        ticket: {
          ...ticket,
          findings: ticket.findings.map((f, i) => (i === event.findingIndex ? { ...f, resolved: true } : f)),
        },
        state,
      };
    case "pr": {
      const draft = state.acceptMode === "observe";
      return {
        ticket: { ...ticket, pr: { number: event.number, branch: event.branch, draft } },
        state: { ...state, metrics: { ...state.metrics, prsOpened: state.metrics.prsOpened + 1 } },
      };
    }
    case "lesson": {
      const lesson = {
        id: `L-${ticket.key}`,
        ticketKey: ticket.key,
        rule: event.rule,
        evidence: event.evidence,
        scope: event.scope,
        confidence: event.confidence,
        status: "candidate" as const,
      };
      const exists = state.lessons.some((l) => l.id === lesson.id);
      return { ticket, state: exists ? state : { ...state, lessons: [lesson, ...state.lessons] } };
    }
    case "tokens":
      return {
        ticket: { ...ticket, tokens: ticket.tokens + event.amount },
        state: { ...state, metrics: { ...state.metrics, tokens: state.metrics.tokens + event.amount } },
      };
  }
}

function replaceTicket(state: EngineState, ticket: Ticket): EngineState {
  return { ...state, tickets: state.tickets.map((t) => (t.id === ticket.id ? ticket : t)) };
}

function startNext(state: EngineState): EngineState {
  const next = state.tickets.find((t) => t.status === "queued");
  if (!next) return { ...state, activeTicketId: null, agents: idleAgents() };
  const started: Ticket = { ...next, status: "running", startedAtTick: state.tick };
  return replaceTicket({ ...state, activeTicketId: next.id }, started);
}

function finish(state: EngineState, ticket: Ticket): EngineState {
  const done: Ticket = { ...ticket, status: "done", endedAtTick: state.tick };
  const duration = state.tick - (ticket.startedAtTick ?? state.tick);
  const metrics = {
    ...state.metrics,
    completed: state.metrics.completed + 1,
    ticksPerTicket: [...state.metrics.ticksPerTicket, duration],
  };
  return replaceTicket({ ...state, metrics, activeTicketId: null, agents: idleAgents() }, done);
}

function advance(state: EngineState, scripts: ReadonlyMap<string, readonly ScriptEvent[]>): EngineState {
  const ticked = { ...state, tick: state.tick + 1 };
  const withActive = ticked.activeTicketId ? ticked : startNext(ticked);
  const active = withActive.tickets.find((t) => t.id === withActive.activeTicketId);
  if (!active) return withActive;

  const script = scripts.get(active.id) ?? [];
  const event = script[active.cursor];
  if (!event) return finish(withActive, active);

  const applied = applyEvent(withActive, active, event);
  const moved: Ticket = { ...applied.ticket, cursor: active.cursor + 1 };
  return replaceTicket(applied.state, moved);
}

function prioritize(state: EngineState, ticketId: string): EngineState {
  const target = state.tickets.find((t) => t.id === ticketId && t.status === "queued");
  if (!target) return state;
  const rest = state.tickets.filter((t) => t.id !== ticketId);
  const firstQueued = rest.findIndex((t) => t.status === "queued");
  const at = firstQueued === -1 ? rest.length : firstQueued;
  return { ...state, tickets: [...rest.slice(0, at), target, ...rest.slice(at)] };
}

function setLessonStatus(state: EngineState, lessonId: string, status: "promoted" | "discarded"): EngineState {
  return {
    ...state,
    lessons: state.lessons.map((l) => (l.id === lessonId && l.status === "candidate" ? { ...l, status } : l)),
  };
}

const clampSpeed = (ms: number): number => Math.min(MAX_SPEED_MS, Math.max(MIN_SPEED_MS, Math.round(ms)));

/** Builds a deterministic, pure engine for the given ticket specs. */
export function createEngine(specs: readonly TicketSpec[]): Engine {
  const scripts = new Map(specs.map((spec) => [spec.id, buildScript(spec)]));
  const initial: EngineState = {
    tick: 0,
    running: true,
    speedMs: DEFAULT_SPEED_MS,
    acceptMode: "observe",
    activeTicketId: null,
    tickets: specs.map((spec) => ticketFromSpec(spec, scripts.get(spec.id)?.length ?? 0)),
    agents: idleAgents(),
    lessons: [
      {
        id: "L-07",
        ticketKey: "ENG-98",
        rule: "Respostas 429 devem incluir Retry-After e não revelar se a conta existe",
        evidence: "review humano no PR #311",
        scope: "demo/api-gateway · src/middleware/**",
        confidence: 0.91,
        status: "promoted",
      },
      {
        id: "L-03",
        ticketKey: "ENG-61",
        rule: "Validar cursores e parâmetros opacos com zod antes de decodificar",
        evidence: "bug de produção ENG-61",
        scope: "demo/api-gateway · src/**",
        confidence: 0.86,
        status: "promoted",
      },
    ],
    metrics: { completed: 0, prsOpened: 0, tokens: 0, ticksPerTicket: [] },
    nextLogId: 1,
  };

  const reduce = (state: EngineState, action: EngineAction): EngineState => {
    switch (action.type) {
      case "tick":
        return state.running ? advance(state, scripts) : state;
      case "toggle":
        return { ...state, running: !state.running };
      case "setSpeed":
        return { ...state, speedMs: clampSpeed(action.speedMs) };
      case "prioritize":
        return prioritize(state, action.ticketId);
      case "promote":
        return setLessonStatus(state, action.lessonId, "promoted");
      case "discard":
        return setLessonStatus(state, action.lessonId, "discarded");
      case "setAcceptMode":
        return { ...state, acceptMode: action.mode };
      case "reset":
        return { ...initial, acceptMode: state.acceptMode, speedMs: state.speedMs };
    }
  };

  return { initial, reduce };
}
