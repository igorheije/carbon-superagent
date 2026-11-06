import "server-only";
import { randomBytes } from "node:crypto";
import { getDb } from "../db";
import { HttpError } from "../http";
import { createWorkerRecord, findWorkerByTokenHash, revokeWorkerRecord, touchLastSeen, type Worker, type WorkerKind } from "../repo/workers";
import { agentcoreSessionId, agentcoreWorkerId } from "../runtimes/session";
import { hashToken } from "./password";
import { isRateLimited, recordFailure } from "./rate-limit";

/**
 * Machine credentials for remote workers. Tokens are shown once (on creation) and stored only as
 * sha256, like user sessions. Every /api/worker/* handler calls requireWorker(); the middleware
 * lets those paths through without the cookie/origin checks.
 */

export const WORKER_TOKEN_PREFIX = "cwk_";
export const TASK_TOKEN_PREFIX = "ctk_";
const TOKEN_BYTES = 32;
/** base64url of 32 bytes, without padding. */
const TOKEN_BODY_LENGTH = 43;
const MAX_NAME_LENGTH = 80;
/** last_seen_at is written at most this often per worker (heartbeats are frequent). */
export const LAST_SEEN_THROTTLE_MS = 30_000;
/** Accepted requests per worker token per window (heartbeats, events, claims). */
export const WORKER_REQUESTS_PER_WINDOW = 600;
export const WORKER_REQUEST_WINDOW_MS = 60_000;

const GENERIC_401 = "não autenticado";

function newToken(prefix: string): string {
  return `${prefix}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

function looksLike(token: string, prefix: string): boolean {
  return token.startsWith(prefix) && token.length === prefix.length + TOKEN_BODY_LENGTH;
}

export interface CreatedWorker {
  readonly worker: Worker;
  /** Plain token: returned only here, never stored or retrievable again. */
  readonly token: string;
}

export function createWorker(name: string, kind: WorkerKind, createdBy: string): CreatedWorker {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) throw new HttpError(400, `nome da máquina com 1 a ${MAX_NAME_LENGTH} caracteres`);
  const token = newToken(WORKER_TOKEN_PREFIX);
  const worker = createWorkerRecord({ name: trimmed, kind, tokenHash: hashToken(token), createdBy });
  return { worker, token };
}

export function revokeWorker(id: string): boolean {
  return revokeWorkerRecord(id);
}

// Fixed-window request counter per worker (in memory, single panel process).
const requestWindows = new Map<string, { readonly start: number; readonly count: number }>();

function overRequestLimit(workerId: string, now: number): boolean {
  const current = requestWindows.get(workerId);
  const window = !current || now - current.start >= WORKER_REQUEST_WINDOW_MS ? { start: now, count: 1 } : { start: current.start, count: current.count + 1 };
  requestWindows.set(workerId, window);
  return window.count > WORKER_REQUESTS_PER_WINDOW;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Authenticates a worker request (Authorization: Bearer cwk_…). Unknown, malformed and revoked
 * tokens all get the same 401. Repeated failures with the same token, and floods from a valid
 * one, get 429.
 */
export function requireWorker(request: Request, now = Date.now()): Worker {
  const token = bearerToken(request);
  if (token && looksLike(token, TASK_TOKEN_PREFIX)) return requireBoundTaskToken(request, token, now);
  if (!token || !looksLike(token, WORKER_TOKEN_PREFIX)) throw new HttpError(401, GENERIC_401);
  const tokenHash = hashToken(token);
  const failureKey = `worker:${tokenHash}`;
  if (isRateLimited(failureKey, now)) throw new HttpError(429, "muitas tentativas; aguarde 15 minutos");
  const worker = findWorkerByTokenHash(tokenHash);
  if (!worker) {
    recordFailure(failureKey, now);
    throw new HttpError(401, GENERIC_401);
  }
  if (overRequestLimit(worker.id, now)) throw new HttpError(429, "muitas requisições; reduza a frequência");
  if (worker.lastSeenAt === null || now - worker.lastSeenAt >= LAST_SEEN_THROTTLE_MS) {
    touchLastSeen(worker.id, now);
    return { ...worker, lastSeenAt: now };
  }
  return worker;
}

/** One-time token bound to a task (AgentCore invocation payload). */
export function issueTaskToken(taskId: string, ttlMs: number, now = Date.now()): string {
  const token = newToken(TASK_TOKEN_PREFIX);
  const db = getDb();
  db.prepare("DELETE FROM task_tokens WHERE expires_at < ?").run(now);
  db.prepare("INSERT INTO task_tokens (token_hash, task_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), taskId, now + ttlMs);
  return token;
}

/**
 * Accepts the token once, only for its own task and before it expires. The check and the burn are
 * one UPDATE, so two concurrent uses cannot both succeed.
 */
export function consumeTaskToken(token: string, taskId: string, now = Date.now()): boolean {
  if (!looksLike(token, TASK_TOKEN_PREFIX)) return false;
  const result = getDb()
    .prepare("UPDATE task_tokens SET used_at = ? WHERE token_hash = ? AND task_id = ? AND used_at IS NULL AND expires_at >= ?")
    .run(now, hashToken(token), taskId, now);
  return Number(result.changes) > 0;
}

// ---------------------------------------------------------------- AgentCore task tokens

/** A container identity for the lease: there is no `workers` row behind it. */
function agentcoreWorker(taskId: string, now: number): Worker {
  return {
    id: agentcoreWorkerId(taskId),
    name: `AgentCore ${agentcoreSessionId(taskId)}`,
    kind: "agentcore",
    createdBy: "system",
    createdAt: now,
    revokedAt: null,
    lastSeenAt: now,
    version: null,
    capabilities: {},
  };
}

const TASK_SCOPED_PATH = /^\/api\/worker\/tasks\/([^/]+)(?:\/|$)/;

/** Task id of a task-scoped worker route (/api/worker/tasks/<id>/...), or null for any other path. */
export function taskScopeOf(request: Request): string | null {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  const match = TASK_SCOPED_PATH.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function guardTaskToken(token: string, now: number): { readonly tokenHash: string; readonly failureKey: string } {
  const tokenHash = hashToken(token);
  const failureKey = `task-token:${tokenHash}`;
  if (isRateLimited(failureKey, now)) throw new HttpError(429, "muitas tentativas; aguarde 15 minutos");
  return { tokenHash, failureKey };
}

function rejectTaskToken(failureKey: string, now: number): never {
  recordFailure(failureKey, now);
  throw new HttpError(401, GENERIC_401);
}

/**
 * After the claim, the same task token keeps authenticating the container, but only:
 * on routes scoped to its own task, after it was burned by the claim, before it expires, and while
 * that task is still running/waiting under the AgentCore lease. Anything else is the generic 401.
 */
function requireBoundTaskToken(request: Request, token: string, now: number): Worker {
  const { tokenHash, failureKey } = guardTaskToken(token, now);
  const taskId = taskScopeOf(request);
  if (!taskId) return rejectTaskToken(failureKey, now);
  const row = getDb()
    .prepare(
      `SELECT k.task_id FROM task_tokens k JOIN tasks t ON t.id = k.task_id
        WHERE k.token_hash = ? AND k.task_id = ? AND k.used_at IS NOT NULL AND k.expires_at >= ?
          AND t.runtime = 'agentcore' AND t.lease_worker = ? AND t.status IN ('running', 'waiting')`,
    )
    .get(tokenHash, taskId, now, agentcoreWorkerId(taskId));
  if (!row) return rejectTaskToken(failureKey, now);
  const worker = agentcoreWorker(taskId, now);
  if (overRequestLimit(worker.id, now)) throw new HttpError(429, "muitas requisições; reduza a frequência");
  return worker;
}

/**
 * The AgentCore container's claim: burns the one-time token of `taskId` (same 401 for unknown,
 * reused, expired or foreign tokens) and returns the synthetic worker that will hold the lease.
 */
export function requireTaskClaim(request: Request, taskId: string, now = Date.now()): Worker {
  const token = bearerToken(request);
  if (!token || !looksLike(token, TASK_TOKEN_PREFIX)) throw new HttpError(401, GENERIC_401);
  const { failureKey } = guardTaskToken(token, now);
  if (!consumeTaskToken(token, taskId, now)) return rejectTaskToken(failureKey, now);
  return agentcoreWorker(taskId, now);
}

/** Drops every token of a finished task (the dispatcher calls it when the session is stopped). */
export function revokeTaskTokens(taskId: string): void {
  getDb().prepare("DELETE FROM task_tokens WHERE task_id = ?").run(taskId);
}
