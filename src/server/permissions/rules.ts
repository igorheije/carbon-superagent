import "server-only";
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "../db";
import { ruleMatches } from "./classify";

export interface PermissionRule {
  readonly id: string;
  readonly repoPath: string;
  readonly tool: string;
  readonly pattern: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

interface Row {
  id: string;
  repo_path: string;
  tool: string;
  pattern: string;
  created_by: string;
  created_at: string;
}

const toRule = (r: Row): PermissionRule => ({ id: r.id, repoPath: r.repo_path, tool: r.tool, pattern: r.pattern, createdBy: r.created_by, createdAt: r.created_at });

export function listRules(repoPath: string): readonly PermissionRule[] {
  const rows = getDb().prepare("SELECT * FROM permission_rules WHERE repo_path = ? ORDER BY created_at DESC").all(repoPath) as unknown as Row[];
  return rows.map(toRule);
}

/** "Always allow in this repo": idempotent per (repo, tool, pattern). */
export function addRule(repoPath: string, tool: string, pattern: string, createdBy: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO permission_rules (id, repo_path, tool, pattern, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), repoPath, tool, pattern, createdBy, nowIso());
}

export function deleteRule(id: string): void {
  getDb().prepare("DELETE FROM permission_rules WHERE id = ?").run(id);
}

export function findMatchingRule(repoPath: string, tool: string, input: unknown): PermissionRule | null {
  return listRules(repoPath).find((r) => ruleMatches(r, tool, input)) ?? null;
}
