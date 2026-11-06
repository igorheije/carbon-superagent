import "server-only";
import type { DatabaseSync } from "node:sqlite";
import type { LogLine, Ticket } from "@/lib/domain/types";
import { getDb, nowIso } from "../db";
import type { ExecutorId } from "../repo/settings";
import { findTask, type Task } from "../repo/tasks";
import { findWorker } from "../repo/workers";

/**
 * Queue for remote runtimes (pool workers, AgentCore sessions). The local runner keeps using
 * `nextQueuedLocalTask`; everything here only touches tasks whose runtime is not "local".
 * A claim gives a worker a time-bounded lease that it must renew; expired leases are swept.
 */

export interface Lease {
  readonly task: Task;
  readonly leaseExpiresAt: number;
}

export type RenewResult = { readonly cancel: boolean } | "lease_lost";

export interface SweepOptions {
  /** true → expired tasks go back to the queue; false → they fail. */
  readonly requeue: boolean;
}

/**
 * Atomic claim of the next pool task: a single conditional UPDATE … RETURNING. The inner SELECT
 * and the outer `status = 'queued'` guard run in the same statement, under BEGIN IMMEDIATE, so two
 * claimers can never both win the same row. Executors are bound as a JSON array (json_each) to keep
 * one prepared statement for any list size. Exported so the multi-process test runs the same SQL.
 */
export const CLAIM_NEXT_SQL = `
  UPDATE tasks
     SET status = 'running',
         snapshot = json_set(snapshot, '$.status', 'running'),
         lease_worker = :worker,
         lease_expires_at = :expires,
         lease_seq = 0,
         cancel_requested = 0,
         updated_at = :now
   WHERE id = (
           SELECT id FROM tasks
            WHERE runtime = 'pool' AND status = 'queued'
              AND executor IN (SELECT value FROM json_each(:executors))
            ORDER BY position
            LIMIT 1
         )
     AND status = 'queued'
  RETURNING id`;

const CLAIM_SPECIFIC_SQL = `
  UPDATE tasks
     SET status = 'running',
         snapshot = json_set(snapshot, '$.status', 'running'),
         lease_worker = :worker,
         lease_expires_at = :expires,
         lease_seq = 0,
         cancel_requested = 0,
         updated_at = :now
   WHERE id = :id
     AND runtime <> 'local'
     AND (status = 'queued' OR (status = 'running' AND lease_worker IS NULL))
  RETURNING id`;

/** Runs fn inside BEGIN IMMEDIATE (write lock taken up front), rolling back on error. */
function immediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function leaseFor(id: string | undefined, expires: number): Lease | null {
  if (!id) return null;
  const task = findTask(id);
  return task ? { task, leaseExpiresAt: expires } : null;
}

/** Gives the oldest queued pool task whose executor the worker supports, or null when there is none. */
export function claimNext(workerId: string, executors: readonly ExecutorId[], leaseMs: number, now = Date.now()): Lease | null {
  if (executors.length === 0) return null;
  const db = getDb();
  const expires = now + leaseMs;
  const row = immediate(db, () =>
    db.prepare(CLAIM_NEXT_SQL).get({ worker: workerId, expires, now: nowIso(), executors: JSON.stringify(executors) }) as { id: string } | undefined,
  );
  return leaseFor(row?.id, expires);
}

/** Claims one known remote task (AgentCore: the container was invoked for exactly this task). */
export function claimSpecific(taskId: string, workerId: string, leaseMs: number, now = Date.now()): Lease | null {
  const db = getDb();
  const expires = now + leaseMs;
  const row = immediate(db, () =>
    db.prepare(CLAIM_SPECIFIC_SQL).get({ id: taskId, worker: workerId, expires, now: nowIso() }) as { id: string } | undefined,
  );
  return leaseFor(row?.id, expires);
}

/**
 * Extends the lease of a task the worker still owns. "lease_lost" when the task was reassigned,
 * swept, finished, or the lease already expired — the worker must stop working on it.
 */
export function renew(taskId: string, workerId: string, leaseMs: number, now = Date.now()): RenewResult {
  const row = getDb()
    .prepare(
      `UPDATE tasks SET lease_expires_at = ?
        WHERE id = ? AND lease_worker = ? AND lease_expires_at >= ? AND status IN ('running', 'waiting')
       RETURNING cancel_requested`,
    )
    .get(now + leaseMs, taskId, workerId, now) as { cancel_requested: number } | undefined;
  return row ? { cancel: row.cancel_requested === 1 } : "lease_lost";
}

/** Flags a remote task under lease for cancellation; the worker sees it on its next renew. */
export function requestCancel(taskId: string): boolean {
  const result = getDb()
    .prepare("UPDATE tasks SET cancel_requested = 1 WHERE id = ? AND runtime <> 'local' AND status IN ('running', 'waiting') AND lease_worker IS NOT NULL")
    .run(taskId);
  return Number(result.changes) > 0;
}

/** The worker is done with the task (result reported): drop its lease without touching the status. */
export function releaseLease(taskId: string, workerId: string): boolean {
  const result = getDb()
    .prepare("UPDATE tasks SET lease_worker = NULL, lease_expires_at = NULL WHERE id = ? AND lease_worker = ?")
    .run(taskId, workerId);
  return Number(result.changes) > 0;
}

export const DELIVERY_INTERRUPTED = "painel reiniciou durante a entrega — use “rodar de novo”";

/**
 * Boot-time recovery for pool tasks left `running` without a lease. The result route releases
 * the lease before importing/pushing (so a slow delivery is never swept), which means a panel
 * restart in that window leaves the task with nobody owning it and no sweep that would ever end
 * it. Such tasks fail with an explicit log line. AgentCore tasks are excluded on purpose: they
 * are legitimately `running` without a lease between dispatch and the container's claim.
 * Returns the ids that changed.
 */
export function recoverUnleasedRemoteTasks(): readonly string[] {
  const db = getDb();
  return immediate(db, () => {
    const rows = db
      .prepare("SELECT id, snapshot FROM tasks WHERE runtime = 'pool' AND lease_worker IS NULL AND status IN ('running', 'waiting')")
      .all() as unknown as { id: string; snapshot: string }[];
    const update = db.prepare(
      "UPDATE tasks SET status = 'failed', snapshot = ?, cancel_requested = 0, updated_at = ? WHERE id = ? AND lease_worker IS NULL AND status IN ('running', 'waiting')",
    );
    const changed: string[] = [];
    for (const row of rows) {
      const snapshot = JSON.parse(row.snapshot) as Ticket;
      const failed: Ticket = { ...snapshot, status: "failed", logs: withLog(snapshot, DELIVERY_INTERRUPTED) };
      if (Number(update.run(JSON.stringify(failed), nowIso(), row.id).changes) > 0) changed.push(row.id);
    }
    return changed;
  });
}

interface ExpiredRow {
  id: string;
  lease_worker: string;
  lease_expires_at: number;
  snapshot: string;
}

function withLog(snapshot: Ticket, text: string): readonly LogLine[] {
  const lastId = snapshot.logs.at(-1)?.id ?? 0;
  return [...snapshot.logs, { id: lastId + 1, stage: snapshot.stage ?? "intake", level: "warn", text }];
}

function expiredSnapshot(row: ExpiredRow, requeue: boolean, now: number): Ticket {
  const snapshot = JSON.parse(row.snapshot) as Ticket;
  const who = findWorker(row.lease_worker)?.name ?? row.lease_worker;
  const at = new Date(now).toISOString();
  const text = requeue
    ? `worker ${who} parou de responder (${at}) — tarefa devolvida à fila`
    : `worker ${who} parou de responder (${at}) — use “rodar de novo”`;
  return { ...snapshot, status: requeue ? "queued" : "failed", logs: withLog(snapshot, text) };
}

/**
 * Remote tasks whose lease expired: failed (default) or back to queued when `requeue`.
 * Each row is updated only if its lease is still the expired one, so a concurrent renew wins.
 * Returns the ids that changed.
 */
export function sweepExpiredLeases(now: number, options: SweepOptions): readonly string[] {
  const db = getDb();
  return immediate(db, () => {
    const rows = db
      .prepare(
        `SELECT id, lease_worker, lease_expires_at, snapshot FROM tasks
          WHERE runtime <> 'local' AND lease_worker IS NOT NULL AND lease_expires_at < ? AND status IN ('running', 'waiting')`,
      )
      .all(now) as unknown as ExpiredRow[];
    const update = db.prepare(
      `UPDATE tasks SET status = ?, snapshot = ?, lease_worker = NULL, lease_expires_at = NULL, cancel_requested = 0, updated_at = ?
        WHERE id = ? AND lease_worker = ? AND lease_expires_at = ?`,
    );
    const changed: string[] = [];
    for (const row of rows) {
      const snapshot = expiredSnapshot(row, options.requeue, now);
      const result = update.run(snapshot.status, JSON.stringify(snapshot), nowIso(), row.id, row.lease_worker, row.lease_expires_at);
      if (Number(result.changes) > 0) changed.push(row.id);
    }
    return changed;
  });
}
