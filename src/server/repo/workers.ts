import "server-only";
import { randomUUID } from "node:crypto";
import { getDb } from "../db";

/** A machine that runs tasks for the panel. Tokens are generated in auth/worker-auth.ts; only their hash lives here. */
export type WorkerKind = "pool" | "agentcore";

/** Whether the node takes new tasks: paused = drain (finishes current ones), pending = waiting for admin approval. */
export const WORKER_AVAILABILITIES = ["active", "paused", "pending"] as const;
export type WorkerAvailability = (typeof WORKER_AVAILABILITIES)[number];

/** manual = created in the panel/CLI with its own token; join = entered with the cluster join token. */
export type WorkerOrigin = "manual" | "join";

export interface WorkerCapabilities {
  readonly executors?: readonly string[];
  readonly git?: boolean;
  readonly maxParallel?: number;
}

export interface Worker {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkerKind;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly lastSeenAt: number | null;
  readonly version: string | null;
  readonly capabilities: WorkerCapabilities;
  readonly availability: WorkerAvailability;
  readonly joinedVia: WorkerOrigin;
  readonly hostname: string | null;
}

interface WorkerRow {
  id: string;
  name: string;
  kind: string;
  token_hash: string;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  last_seen_at: number | null;
  version: string | null;
  capabilities: string;
  availability: string;
  joined_via: string;
  hostname: string | null;
}

const asAvailability = (raw: string): WorkerAvailability =>
  (WORKER_AVAILABILITIES as readonly string[]).includes(raw) ? (raw as WorkerAvailability) : "paused";

function parseCapabilities(raw: string): WorkerCapabilities {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as WorkerCapabilities) : {};
  } catch {
    return {};
  }
}

function toWorker(row: WorkerRow): Worker {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as WorkerKind,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
    version: row.version,
    capabilities: parseCapabilities(row.capabilities),
    availability: asAvailability(row.availability),
    joinedVia: row.joined_via === "join" ? "join" : "manual",
    hostname: row.hostname,
  };
}

export interface NewWorker {
  readonly name: string;
  readonly kind: WorkerKind;
  readonly tokenHash: string;
  readonly createdBy: string;
  readonly joinedVia?: WorkerOrigin;
  readonly hostname?: string | null;
  readonly availability?: WorkerAvailability;
}

export function createWorkerRecord(input: NewWorker, now = Date.now()): Worker {
  const id = randomUUID();
  getDb()
    .prepare(
      "INSERT INTO workers (id, name, kind, token_hash, created_by, created_at, joined_via, hostname, availability) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, input.name, input.kind, input.tokenHash, input.createdBy, now, input.joinedVia ?? "manual", input.hostname ?? null, input.availability ?? "active");
  return findWorker(id) as Worker;
}

export function findWorker(id: string): Worker | null {
  const row = getDb().prepare("SELECT * FROM workers WHERE id = ?").get(id) as WorkerRow | undefined;
  return row ? toWorker(row) : null;
}

/** Active (not revoked) worker owning this token hash. */
export function findWorkerByTokenHash(tokenHash: string): Worker | null {
  const row = getDb().prepare("SELECT * FROM workers WHERE token_hash = ? AND revoked_at IS NULL").get(tokenHash) as WorkerRow | undefined;
  return row ? toWorker(row) : null;
}

/** Returns false when the worker does not exist or was already revoked. */
export function revokeWorkerRecord(id: string, now = Date.now()): boolean {
  const result = getDb().prepare("UPDATE workers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
  return Number(result.changes) > 0;
}

export function touchLastSeen(id: string, now = Date.now(), version?: string): void {
  if (version === undefined) {
    getDb().prepare("UPDATE workers SET last_seen_at = ? WHERE id = ?").run(now, id);
    return;
  }
  getDb().prepare("UPDATE workers SET last_seen_at = ?, version = ? WHERE id = ?").run(now, version, id);
}

export function setCapabilities(id: string, capabilities: WorkerCapabilities): void {
  getDb().prepare("UPDATE workers SET capabilities = ? WHERE id = ?").run(JSON.stringify(capabilities), id);
}

export function listWorkers(): readonly Worker[] {
  const rows = getDb().prepare("SELECT * FROM workers ORDER BY created_at, name").all() as unknown as WorkerRow[];
  return rows.map(toWorker);
}

/** Pause (drain), resume or approve a node. False when it does not exist or was removed. */
export function setAvailability(id: string, availability: WorkerAvailability): boolean {
  const result = getDb().prepare("UPDATE workers SET availability = ? WHERE id = ? AND revoked_at IS NULL").run(availability, id);
  return Number(result.changes) > 0;
}

/** Current availability, read fresh (the claim long-poll re-checks it so a pause applies mid-poll). */
export function availabilityOf(id: string): WorkerAvailability | null {
  const row = getDb().prepare("SELECT availability FROM workers WHERE id = ? AND revoked_at IS NULL").get(id) as { availability: string } | undefined;
  return row ? asAvailability(row.availability) : null;
}
