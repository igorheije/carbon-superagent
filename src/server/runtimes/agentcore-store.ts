import "server-only";
import type { LogLevel, Ticket } from "@/lib/domain/types";
import { getDb, nowIso } from "../db";
import { appendLog } from "../runner/ticket-log";

/**
 * Task-table state for AgentCore sessions. No new columns: between dispatch and the container's
 * claim an AgentCore task is `running` with `lease_worker IS NULL`, and `lease_expires_at` holds
 * the claim deadline (dispatch + CLAIM_DEADLINE_MS). claimSpecific overwrites it with the real
 * lease; releaseLease (result route) clears both, so a task under delivery is never mistaken for
 * a lost session.
 */

/** A dispatched session must claim its task within this window, or the task fails. */
export const CLAIM_DEADLINE_MS = 10 * 60_000;
export const SESSION_LOST = "sessão AgentCore não respondeu";

interface Row {
  id: string;
  snapshot: string;
}

const logged = (snapshot: Ticket, status: Ticket["status"], level: LogLevel, text: string): Ticket =>
  appendLog({ ...snapshot, status }, snapshot.stage ?? "intake", level, text);

/** Running AgentCore tasks: each one holds (or is about to hold) a session. */
export function countActiveSessions(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE runtime = 'agentcore' AND status = 'running'").get() as { n: number };
  return row.n;
}

export function queuedAgentCoreTasks(limit: number): readonly string[] {
  if (limit <= 0) return [];
  const rows = getDb().prepare("SELECT id FROM tasks WHERE runtime = 'agentcore' AND status = 'queued' ORDER BY position LIMIT ?").all(limit) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

export function runningAgentCoreTasks(): readonly string[] {
  const rows = getDb().prepare("SELECT id FROM tasks WHERE runtime = 'agentcore' AND status = 'running'").all() as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

export function taskStatus(taskId: string): Ticket["status"] | null {
  const row = getDb().prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: Ticket["status"] } | undefined;
  return row?.status ?? null;
}

function readQueued(taskId: string): Row | undefined {
  return getDb().prepare("SELECT id, snapshot FROM tasks WHERE id = ? AND runtime = 'agentcore' AND status = 'queued'").get(taskId) as Row | undefined;
}

/**
 * queued → running (unclaimed) with the claim deadline and a log line naming the session. Done
 * before Invoke so the container can claim as soon as it starts. false when the task is no
 * longer queued (canceled, deleted, taken).
 */
export function markDispatched(taskId: string, sessionId: string, now: number): boolean {
  const row = readQueued(taskId);
  if (!row) return false;
  const snapshot = logged(JSON.parse(row.snapshot) as Ticket, "running", "info", `AgentCore: invocando sessão ${sessionId}`);
  const result = getDb()
    .prepare(
      `UPDATE tasks SET status = 'running', snapshot = ?, lease_worker = NULL, lease_expires_at = ?, lease_seq = 0, cancel_requested = 0, updated_at = ?
        WHERE id = ? AND runtime = 'agentcore' AND status = 'queued'`,
    )
    .run(JSON.stringify(snapshot), now + CLAIM_DEADLINE_MS, nowIso(), taskId);
  return Number(result.changes) > 0;
}

/** Fails a dispatched task the container has not claimed yet (Invoke failed). */
export function failUnclaimed(taskId: string, reason: string): boolean {
  const row = getDb()
    .prepare("SELECT id, snapshot FROM tasks WHERE id = ? AND runtime = 'agentcore' AND status = 'running' AND lease_worker IS NULL")
    .get(taskId) as Row | undefined;
  if (!row) return false;
  const snapshot = logged(JSON.parse(row.snapshot) as Ticket, "failed", "warn", reason);
  const result = getDb()
    .prepare(
      "UPDATE tasks SET status = 'failed', snapshot = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND lease_worker IS NULL",
    )
    .run(JSON.stringify(snapshot), nowIso(), taskId);
  return Number(result.changes) > 0;
}

/**
 * Boot and sweeper recovery: AgentCore tasks dispatched more than CLAIM_DEADLINE_MS ago whose
 * container never claimed them fail with SESSION_LOST. Returns the ids that changed.
 */
export function failLostSessions(now: number): readonly string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, snapshot, lease_expires_at FROM tasks
        WHERE runtime = 'agentcore' AND status = 'running' AND lease_worker IS NULL
          AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    )
    .all(now) as unknown as (Row & { lease_expires_at: number })[];
  const update = db.prepare(
    `UPDATE tasks SET status = 'failed', snapshot = ?, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_worker IS NULL AND lease_expires_at = ?`,
  );
  const changed: string[] = [];
  for (const row of rows) {
    const snapshot = logged(JSON.parse(row.snapshot) as Ticket, "failed", "warn", `${SESSION_LOST} em ${CLAIM_DEADLINE_MS / 60_000} min — use “rodar de novo”`);
    if (Number(update.run(JSON.stringify(snapshot), nowIso(), row.id, row.lease_expires_at).changes) > 0) changed.push(row.id);
  }
  return changed;
}
