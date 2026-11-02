import "server-only";
import { randomUUID } from "node:crypto";
import type { PersonaId } from "@/lib/domain/personas";
import { hashToken, newSessionToken } from "../auth/password";
import { getDb, nowIso } from "../db";

export type Role = "admin" | "member";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly persona: PersonaId;
  readonly role: Role;
  readonly mustChangePassword: boolean;
  readonly createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  persona: string;
  role: string;
  must_change_password: number;
  created_at: string;
}

export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    persona: row.persona as PersonaId,
    role: row.role as Role,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
  };
}

export function countUsers(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  return row.n;
}

export function listUsers(): readonly User[] {
  const rows = getDb().prepare("SELECT * FROM users ORDER BY created_at").all() as unknown as UserRow[];
  return rows.map(toUser);
}

export function findUserByEmail(email: string): (User & { readonly passwordHash: string }) | null {
  const row = getDb().prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as UserRow | undefined;
  return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
}

export function findUserById(id: string): User | null {
  const row = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export interface NewUser {
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly persona: PersonaId;
  readonly role: Role;
  readonly mustChangePassword: boolean;
}

export function createUser(input: NewUser): User {
  const id = randomUUID();
  getDb()
    .prepare(
      "INSERT INTO users (id, email, name, password_hash, persona, role, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, input.email.toLowerCase(), input.name, input.passwordHash, input.persona, input.role, input.mustChangePassword ? 1 : 0, nowIso());
  return findUserById(id) as User;
}

export function updateUserProfile(id: string, patch: { readonly name: string; readonly persona: PersonaId }): User | null {
  getDb().prepare("UPDATE users SET name = ?, persona = ? WHERE id = ?").run(patch.name, patch.persona, id);
  return findUserById(id);
}

export function updatePassword(id: string, passwordHash: string): void {
  getDb().prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(passwordHash, id);
}

export function deleteUser(id: string): void {
  getDb().prepare("DELETE FROM users WHERE id = ?").run(id);
}

export function createSession(userId: string): { readonly token: string; readonly expiresAt: number } {
  const token = newSessionToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  getDb().prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(hashToken(token), userId, expiresAt, nowIso());
  return { token, expiresAt };
}

export function userForSession(token: string): User | null {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  const row = db
    .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at >= ?")
    .get(hashToken(token), Date.now()) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function deleteSession(token: string): void {
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function deleteSessionsForUser(userId: string): void {
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}
