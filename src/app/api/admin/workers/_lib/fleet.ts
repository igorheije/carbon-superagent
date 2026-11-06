import "server-only";
import { getDb } from "@/server/db";
import { listWorkers, type Worker, type WorkerCapabilities, type WorkerKind } from "@/server/repo/workers";

/**
 * Fleet view (FLT-01) for Configurações → Máquinas. Status comes from `last_seen_at` and the tasks the
 * worker currently holds a lease on. "online" is not a state of its own: an online worker is
 * either `busy` (holds at least one lease) or `idle`.
 */
export type WorkerStatus = "busy" | "idle" | "offline" | "revoked";

/** A worker is offline when it has not been seen for this many lease periods. */
export const OFFLINE_AFTER_LEASES = 2;

export interface WorkerTaskRef {
  readonly id: string;
  readonly key: string;
}

export interface FleetWorker {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkerKind;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly lastSeenAt: number | null;
  readonly version: string | null;
  readonly capabilities: WorkerCapabilities;
  readonly status: WorkerStatus;
  readonly currentTasks: readonly WorkerTaskRef[];
}

interface LeaseRow {
  id: string;
  key: string;
  lease_worker: string;
}

/** Tasks currently leased by a worker (running or waiting), grouped by worker id. */
function leasesByWorker(): ReadonlyMap<string, readonly WorkerTaskRef[]> {
  const rows = getDb()
    .prepare("SELECT id, key, lease_worker FROM tasks WHERE lease_worker IS NOT NULL AND status IN ('running', 'waiting') ORDER BY key")
    .all() as unknown as LeaseRow[];
  return rows.reduce((map, row) => {
    const refs = map.get(row.lease_worker) ?? [];
    return new Map(map).set(row.lease_worker, [...refs, { id: row.id, key: row.key }]);
  }, new Map<string, readonly WorkerTaskRef[]>());
}

export function workerStatus(worker: Pick<Worker, "revokedAt" | "lastSeenAt">, taskCount: number, leaseMs: number, now: number): WorkerStatus {
  if (worker.revokedAt !== null) return "revoked";
  if (worker.lastSeenAt === null || now - worker.lastSeenAt > OFFLINE_AFTER_LEASES * leaseMs) return "offline";
  return taskCount > 0 ? "busy" : "idle";
}

export function listFleet(leaseMs: number, now = Date.now()): readonly FleetWorker[] {
  const leases = leasesByWorker();
  return listWorkers().map((worker) => {
    const currentTasks = worker.revokedAt === null ? (leases.get(worker.id) ?? []) : [];
    return {
      id: worker.id,
      name: worker.name,
      kind: worker.kind,
      createdAt: worker.createdAt,
      revokedAt: worker.revokedAt,
      lastSeenAt: worker.lastSeenAt,
      version: worker.version,
      capabilities: worker.capabilities,
      status: workerStatus(worker, currentTasks.length, leaseMs, now),
      currentTasks,
    };
  });
}
