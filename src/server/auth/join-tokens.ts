import "server-only";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db";
import { hashToken } from "./password";
import { looksLike, newToken } from "./worker-auth";

/**
 * Cluster join token (Docker Swarm-like): one shared `cjt_` token lets any number of servers enter
 * the cluster. Joining trades it for the node's own `cwk_` credential, so the join token is never
 * used to claim tasks. Only one token is active at a time; rotating revokes the previous one.
 * Only the sha256 is stored: the plain token is returned once, on creation/rotation.
 */
export const JOIN_TOKEN_PREFIX = "cjt_";

export const MAX_JOIN_TTL_HOURS = 24 * 365;
export const MAX_JOIN_USES = 10_000;

export interface JoinTokenInfo {
  readonly id: string;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly expiresAt: number | null;
  readonly maxUses: number | null;
  readonly uses: number;
}

export interface JoinTokenOptions {
  readonly ttlMs?: number | null;
  readonly maxUses?: number | null;
}

interface JoinTokenRow {
  id: string;
  created_at: number;
  created_by: string;
  expires_at: number | null;
  max_uses: number | null;
  uses: number;
}

const toInfo = (row: JoinTokenRow): JoinTokenInfo => ({
  id: row.id,
  createdAt: row.created_at,
  createdBy: row.created_by,
  expiresAt: row.expires_at,
  maxUses: row.max_uses,
  uses: row.uses,
});

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
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

/** Creates a new join token and revokes every other one, atomically. The plain token is returned only here. */
export function rotateJoinToken(createdBy: string, options: JoinTokenOptions = {}, now = Date.now()): { readonly token: string; readonly info: JoinTokenInfo } {
  const token = newToken(JOIN_TOKEN_PREFIX);
  const id = randomUUID();
  const expiresAt = options.ttlMs ? now + options.ttlMs : null;
  const db = getDb();
  inTransaction(db, () => {
    db.prepare("UPDATE join_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(now);
    db.prepare("INSERT INTO join_tokens (id, token_hash, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      hashToken(token),
      createdBy,
      now,
      expiresAt,
      options.maxUses ?? null,
    );
  });
  return { token, info: { id, createdAt: now, createdBy, expiresAt, maxUses: options.maxUses ?? null, uses: 0 } };
}

/** Turns joining off: no join token is accepted until a new one is generated. Existing nodes keep working. */
export function disableJoinToken(now = Date.now()): boolean {
  const result = getDb().prepare("UPDATE join_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(now);
  return Number(result.changes) > 0;
}

/** The active token's metadata (never the secret), or null when joining is off or the token ran out. */
export function joinTokenInfo(now = Date.now()): JoinTokenInfo | null {
  const row = getDb()
    .prepare(
      `SELECT id, created_at, created_by, expires_at, max_uses, uses FROM join_tokens
       WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(now) as JoinTokenRow | undefined;
  return row ? toInfo(row) : null;
}

/**
 * Spends one use of the join token when it is valid (active, not expired, uses left). The check and
 * the increment are one conditional UPDATE, so two concurrent joins can never both take the last use.
 */
export function consumeJoinToken(token: string, now = Date.now()): JoinTokenInfo | null {
  if (!looksLike(token, JOIN_TOKEN_PREFIX)) return null;
  const row = getDb()
    .prepare(
      `UPDATE join_tokens SET uses = uses + 1
       WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)
       RETURNING id, created_at, created_by, expires_at, max_uses, uses`,
    )
    .get(hashToken(token), now) as JoinTokenRow | undefined;
  return row ? toInfo(row) : null;
}
