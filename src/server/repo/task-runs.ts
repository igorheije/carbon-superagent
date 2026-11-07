import "server-only";
import { getDb } from "../db";

/**
 * One row per execution of a task on a machine: the local runner (workerId null) or a pool /
 * AgentCore worker. Feeds Configurações → Máquinas → Carga (throughput, utilization, success).
 * Writes are best effort: a failure here must never break claiming or finishing a task.
 */
export type RunOutcome = "done" | "failed" | "waiting" | "lost" | "canceled";

export interface RunRow {
  readonly workerId: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly outcome: string | null;
}

export interface NodeRunStats {
  /** Executions that ended inside the window. */
  readonly finished: number;
  readonly done: number;
  readonly failed: number;
  /** Executions open right now. */
  readonly running: number;
  /** done / (done + failed); null without finished runs. */
  readonly successRate: number | null;
  /** Mean duration of runs that ended `done` in the window; null without any. */
  readonly avgDoneMs: number | null;
  /** Machine time spent running tasks inside the window (overlaps clipped to the window). */
  readonly busyMs: number;
}

const LOCAL = "local";

function safely(action: () => void): void {
  try {
    action();
  } catch {
    // metrics are best effort; the scheduler's own transaction must not fail because of them
  }
}

/** Opens an execution (closing any run left open for the same task, e.g. after a crash). */
export function startRun(taskId: string, workerId: string | null, now = Date.now()): void {
  safely(() => {
    const db = getDb();
    db.prepare("UPDATE task_runs SET finished_at = ?, outcome = 'lost' WHERE task_id = ? AND finished_at IS NULL").run(now, taskId);
    db.prepare("INSERT INTO task_runs (task_id, worker_id, started_at) VALUES (?, ?, ?)").run(taskId, workerId, now);
  });
}

/** Closes the open execution of the task, if any. */
export function finishRun(taskId: string, outcome: RunOutcome, now = Date.now()): void {
  safely(() => {
    getDb().prepare("UPDATE task_runs SET finished_at = ?, outcome = ? WHERE task_id = ? AND finished_at IS NULL").run(now, outcome, taskId);
  });
}

/** Maps a ticket status to the outcome stored for the run that produced it. */
export function outcomeOfStatus(status: string): RunOutcome {
  if (status === "done" || status === "failed" || status === "waiting") return status;
  return "canceled";
}

/** Runs that overlap [since, now]: still open, or finished after `since`. */
export function runsSince(since: number): readonly RunRow[] {
  const rows = getDb()
    .prepare("SELECT worker_id, started_at, finished_at, outcome FROM task_runs WHERE finished_at IS NULL OR finished_at >= ?")
    .all(since) as unknown as { worker_id: string | null; started_at: number; finished_at: number | null; outcome: string | null }[];
  return rows.map((r) => ({ workerId: r.worker_id, startedAt: r.started_at, finishedAt: r.finished_at, outcome: r.outcome }));
}

const EMPTY: NodeRunStats = { finished: 0, done: 0, failed: 0, running: 0, successRate: null, avgDoneMs: null, busyMs: 0 };

/** Groups runs per machine ("local" for this computer) and summarizes the window [now - windowMs, now]. */
export function summarizeRuns(rows: readonly RunRow[], windowMs: number, now: number): ReadonlyMap<string, NodeRunStats> {
  const since = now - windowMs;
  const groups = rows.reduce((map, row) => {
    const key = row.workerId ?? LOCAL;
    return new Map(map).set(key, [...(map.get(key) ?? []), row]);
  }, new Map<string, readonly RunRow[]>());

  return new Map(
    [...groups].map(([key, list]) => {
      const finished = list.filter((r) => r.finishedAt !== null && r.finishedAt >= since);
      const done = finished.filter((r) => r.outcome === "done");
      const failed = finished.filter((r) => r.outcome === "failed" || r.outcome === "lost").length;
      const busyMs = list.reduce((sum, r) => sum + Math.max(0, Math.min(r.finishedAt ?? now, now) - Math.max(r.startedAt, since)), 0);
      const doneMs = done.reduce((sum, r) => sum + ((r.finishedAt ?? now) - r.startedAt), 0);
      const stats: NodeRunStats = {
        finished: finished.length,
        done: done.length,
        failed,
        running: list.filter((r) => r.finishedAt === null).length,
        successRate: done.length + failed > 0 ? done.length / (done.length + failed) : null,
        avgDoneMs: done.length > 0 ? Math.round(doneMs / done.length) : null,
        busyMs,
      };
      return [key, stats] as const;
    }),
  );
}

export function statsFor(map: ReadonlyMap<string, NodeRunStats>, workerId: string | null): NodeRunStats {
  return map.get(workerId ?? LOCAL) ?? EMPTY;
}
