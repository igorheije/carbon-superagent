import "server-only";
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "../db";

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly repoPath: string;
  readonly baseBranch: string;
  readonly createdAt: string;
}

interface Row {
  id: string;
  name: string;
  repo_path: string;
  base_branch: string;
  created_at: string;
}

const toProject = (r: Row): Project => ({ id: r.id, name: r.name, repoPath: r.repo_path, baseBranch: r.base_branch, createdAt: r.created_at });

export function listProjects(): readonly Project[] {
  return (getDb().prepare("SELECT * FROM projects ORDER BY created_at").all() as unknown as Row[]).map(toProject);
}

export function findProject(id: string): Project | null {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
  return row ? toProject(row) : null;
}

export function findProjectByRepo(repoPath: string): Project | null {
  const row = getDb().prepare("SELECT * FROM projects WHERE repo_path = ?").get(repoPath) as Row | undefined;
  return row ? toProject(row) : null;
}

export function createProject(input: { readonly name: string; readonly repoPath: string; readonly baseBranch: string }): Project {
  const id = randomUUID();
  getDb().prepare("INSERT INTO projects (id, name, repo_path, base_branch, created_at) VALUES (?, ?, ?, ?, ?)").run(id, input.name, input.repoPath, input.baseBranch, nowIso());
  return findProject(id) as Project;
}

export function updateProject(id: string, patch: { readonly name?: string; readonly baseBranch?: string }): Project | null {
  const current = findProject(id);
  if (!current) return null;
  getDb().prepare("UPDATE projects SET name = ?, base_branch = ? WHERE id = ?").run(patch.name ?? current.name, patch.baseBranch ?? current.baseBranch, id);
  return findProject(id);
}

/** Removes a project and everything that only makes sense inside it. Callers check for live work first. */
export function deleteProject(id: string): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    for (const sql of [
      "DELETE FROM kb_files WHERE project_id = ?",
      "DELETE FROM kb_edges WHERE project_id = ?",
      "DELETE FROM kb_fts WHERE project_id = ?",
      "DELETE FROM kb_meta WHERE project_id = ?",
      "DELETE FROM tasks WHERE project_id = ?",
      "DELETE FROM lessons WHERE project_id = ?",
      "UPDATE users SET active_project_id = NULL WHERE active_project_id = ?",
      "DELETE FROM projects WHERE id = ?",
    ]) db.prepare(sql).run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function setActiveProject(userId: string, projectId: string): void {
  getDb().prepare("UPDATE users SET active_project_id = ? WHERE id = ?").run(projectId, userId);
}

/** The user's chosen project, else the first one; null only before any project exists. */
export function activeProjectFor(userId: string): Project | null {
  const row = getDb().prepare("SELECT active_project_id AS id FROM users WHERE id = ?").get(userId) as { id: string | null } | undefined;
  const chosen = row?.id ? findProject(row.id) : null;
  return chosen ?? listProjects()[0] ?? null;
}

export function projectTaskCounts(id: string): { readonly live: number; readonly total: number } {
  const row = getDb()
    .prepare("SELECT SUM(CASE WHEN status IN ('queued','running','waiting') THEN 1 ELSE 0 END) AS live, COUNT(*) AS total FROM tasks WHERE project_id = ?")
    .get(id) as { live: number | null; total: number };
  return { live: row.live ?? 0, total: row.total };
}
