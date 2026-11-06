import "server-only";
import { EventEmitter } from "node:events";
import type { StageId, Ticket } from "@/lib/domain/types";
import type { ExecutorEvent } from "../executors/events";
import { describePermission } from "@/shared/executors/claude-parse";
import { getDb, nowIso } from "../db";
import { saveSnapshot } from "../repo/tasks";
import { appendLog, applyExecutorEvent, emptyContext, type RunContext } from "./apply";
import { registerRemotePrompt, remoteState } from "./remote-permissions";

/**
 * Live ticket persistence shared by the local runner and remote event ingestion: the ticket is
 * saved to SQLite and a "change" is emitted so the SSE stream pushes it to the browser.
 */

export const SAVE_THROTTLE_MS = 400;
export const CHANGE_EVENT = "change";

interface LiveGlobals {
  carbonLiveEvents?: EventEmitter;
  carbonRemoteContexts?: Map<string, RunContext>;
}
const globals = globalThis as unknown as LiveGlobals;

/** Process-wide emitter for ticket changes ("change") and lifecycle events ("task"). */
export function liveEvents(): EventEmitter {
  if (!globals.carbonLiveEvents) {
    const events = new EventEmitter();
    events.setMaxListeners(100);
    globals.carbonLiveEvents = events;
  }
  return globals.carbonLiveEvents;
}

export const notifyLive = (): void => {
  liveEvents().emit(CHANGE_EVENT);
};

export interface LiveTicket {
  readonly get: () => Ticket;
  readonly set: (next: Ticket, force?: boolean) => void;
  readonly log: (stage: StageId, level: Parameters<typeof appendLog>[2], text: string, force?: boolean) => void;
}

/** Holds the live ticket in memory and persists it at most every SAVE_THROTTLE_MS (or when forced). */
export function createLiveTicket(taskId: string, initial: Ticket): LiveTicket {
  let ticket: Ticket = initial;
  let lastSave = 0;
  const persist = (force = false) => {
    const now = Date.now();
    if (!force && now - lastSave < SAVE_THROTTLE_MS) return;
    lastSave = now;
    saveSnapshot(taskId, ticket);
    notifyLive();
  };
  return {
    get: () => ticket,
    set: (next, force = false) => {
      ticket = next;
      persist(force);
    },
    log: (stage, level, text, force = false) => {
      ticket = appendLog({ ...ticket, stage }, stage, level, text);
      persist(force);
    },
  };
}

// ---------------------------------------------------------------- remote ingestion

function remoteContexts(): Map<string, RunContext> {
  if (!globals.carbonRemoteContexts) globals.carbonRemoteContexts = new Map();
  return globals.carbonRemoteContexts;
}

/**
 * Run context of a remote task. Kept in memory between event batches; after a panel restart it
 * is rebuilt from the ticket (marker plan, session) — lessons collected before the restart are lost.
 */
export function remoteRunContext(taskId: string, ticket: Ticket): RunContext {
  const known = remoteContexts().get(taskId);
  if (known) return known;
  const hasMarkerPlan = ticket.plan.some((step) => step.id.startsWith(`${ticket.id}-p`));
  return { ...emptyContext, hasMarkerPlan, sessionId: ticket.sessionId ?? null, costUsd: ticket.costUsd ?? 0 };
}

/** A fresh claim starts a new run: forget the context of earlier attempts. */
export function resetRemoteContext(taskId: string): void {
  remoteContexts().delete(taskId);
}

interface LeaseRow {
  lease_worker: string | null;
  lease_expires_at: number | null;
  lease_seq: number;
  status: string;
  snapshot: string;
}

/** Open prompts one remote run may have at once; more is a misbehaving worker (M6). */
export const MAX_REMOTE_PENDING_PERMISSIONS = 50;
/** Answered prompts kept in the ticket (pending ones are always kept). */
export const MAX_KEPT_PERMISSIONS = 200;
/** Snapshot size a remote run may grow the ticket to (logs are already capped by MAX_LOGS). */
export const MAX_REMOTE_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export type IngestResult = { readonly acceptedSeq: number } | "lease_lost" | { readonly tooLarge: string };

/**
 * A worker's permission prompt as the panel shows it: summary and detail recomputed from the raw
 * input (the same input the "always allow" pattern comes from), never the worker's own text.
 */
function trustedEvent(event: ExecutorEvent): ExecutorEvent {
  if (event.type !== "permission_request") return event;
  return { ...event, ...describePermission(event.tool, event.input) };
}

/** Drops the oldest answered prompts beyond MAX_KEPT_PERMISSIONS. */
function trimPermissions(ticket: Ticket): Ticket {
  const all = ticket.permissions ?? [];
  if (all.length <= MAX_KEPT_PERMISSIONS) return ticket;
  let excess = all.length - MAX_KEPT_PERMISSIONS;
  const permissions = all.filter((p) => {
    if (excess > 0 && p.status !== "pending") {
      excess -= 1;
      return false;
    }
    return true;
  });
  return { ...ticket, permissions };
}

/**
 * Applies one batch of executor events sent by the worker holding the lease. Idempotent by
 * `seq`: a batch whose seq is not above the last accepted one is ignored (retries after a lost
 * response). Everything between the read and the write is synchronous, so batches of the same
 * task never interleave inside this process.
 */
export function ingestRemoteEvents(taskId: string, workerId: string, seq: number, events: readonly ExecutorEvent[], now = Date.now()): IngestResult {
  const db = getDb();
  const row = db
    .prepare("SELECT lease_worker, lease_expires_at, lease_seq, status, snapshot FROM tasks WHERE id = ?")
    .get(taskId) as LeaseRow | undefined;
  const ownsLease =
    row !== undefined &&
    row.lease_worker === workerId &&
    row.lease_expires_at !== null &&
    row.lease_expires_at >= now &&
    (row.status === "running" || row.status === "waiting");
  if (!row || !ownsLease) return "lease_lost";
  if (seq <= row.lease_seq) return { acceptedSeq: row.lease_seq };

  const initial = JSON.parse(row.snapshot) as Ticket;
  const folded = events.map(trustedEvent).reduce(
    (state, event) => {
      const next = applyExecutorEvent(state.ticket, state.ctx, event);
      // A forwarded prompt also becomes a durable pending entry the human can answer (RMT-01).
      return event.type === "permission_request" ? { ...next, ticket: registerRemotePrompt(next.ticket, event, now) } : next;
    },
    { ticket: initial, ctx: remoteRunContext(taskId, initial) },
  );
  const ticket = trimPermissions(folded.ticket);
  if (remoteState(ticket).pending.length > MAX_REMOTE_PENDING_PERMISSIONS) {
    return { tooLarge: `mais de ${MAX_REMOTE_PENDING_PERMISSIONS} pedidos de permissão pendentes` };
  }
  const snapshot = JSON.stringify(ticket);
  if (Buffer.byteLength(snapshot) > MAX_REMOTE_SNAPSHOT_BYTES) return { tooLarge: "estado da tarefa grande demais" };
  const result = db
    .prepare(
      `UPDATE tasks SET snapshot = ?, status = ?, lease_seq = ?, updated_at = ?
        WHERE id = ? AND lease_worker = ? AND lease_seq = ?`,
    )
    .run(snapshot, ticket.status, seq, nowIso(), taskId, workerId, row.lease_seq);
  if (Number(result.changes) === 0) return "lease_lost";
  remoteContexts().set(taskId, folded.ctx);
  notifyLive();
  return { acceptedSeq: seq };
}
