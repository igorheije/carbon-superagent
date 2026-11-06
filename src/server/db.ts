import "server-only";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * Local-first storage: one SQLite file under CARBON_DATA_DIR (default ./.carbon-data).
 * node:sqlite is built into Node >= 22.13, so there is no native module to compile.
 */
export function dataDir(): string {
  if (process.env.CARBON_DATA_DIR) return path.resolve(process.env.CARBON_DATA_DIR);
  const current = path.join(process.cwd(), ".carbon-data");
  // Installs from before the rename keep working in place (worktrees are registered by path).
  // The legacy folder always wins when present: a stray empty .carbon-data (e.g. created by a
  // dev server mid-upgrade) must never hide the real data.
  const legacy = path.join(process.cwd(), ".leonidas-data");
  return path.resolve(existsSync(legacy) ? legacy : current);
}

function dbFile(dir: string): string {
  const legacy = path.join(dir, "leonidas.db");
  const current = path.join(dir, "carbon.db");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    persona TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','member')),
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    personas TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL CHECK (source IN ('builtin','created','imported')),
    source_url TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    author_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('manual','linear','github')),
    source_ref TEXT,
    requester_id TEXT NOT NULL REFERENCES users(id),
    persona TEXT NOT NULL,
    executor TEXT NOT NULL CHECK (executor IN ('claude','codex')),
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL,
    position INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE lessons (
    id TEXT PRIMARY KEY,
    task_key TEXT NOT NULL,
    rule TEXT NOT NULL,
    evidence TEXT NOT NULL,
    scope TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('candidate','promoted','discarded')),
    created_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE tasks ADD COLUMN model TEXT NOT NULL DEFAULT 'auto';
  CREATE TABLE kb_files (
    path TEXT PRIMARY KEY,
    lang TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    symbols TEXT NOT NULL,
    summary TEXT NOT NULL,
    in_degree INTEGER NOT NULL DEFAULT 0,
    out_degree INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE kb_edges (src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, dst));
  CREATE INDEX kb_edges_dst ON kb_edges(dst);
  CREATE VIRTUAL TABLE kb_fts USING fts5(file UNINDEXED, path, symbols, body, tokenize = 'unicode61 remove_diacritics 2');
  CREATE TABLE kb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  CREATE TABLE permission_rules (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    tool TEXT NOT NULL,
    pattern TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (repo_path, tool, pattern)
  );
  `,
  `
  ALTER TABLE tasks ADD COLUMN effort TEXT NOT NULL DEFAULT 'auto';
  `,
  `
  UPDATE skills SET name = 'carbon-' || substr(name, 10), body = replace(body, 'LEONIDAS_', 'CARBON_')
    WHERE source = 'builtin' AND name LIKE 'leonidas-%';
  `,
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL UNIQUE,
    base_branch TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  ALTER TABLE tasks ADD COLUMN project_id TEXT;
  ALTER TABLE lessons ADD COLUMN project_id TEXT;
  ALTER TABLE users ADD COLUMN active_project_id TEXT;
  CREATE INDEX tasks_project ON tasks(project_id, position);
  DROP TABLE kb_files;
  DROP TABLE kb_edges;
  DROP TABLE kb_fts;
  DROP TABLE kb_meta;
  CREATE TABLE kb_files (
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    lang TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    symbols TEXT NOT NULL,
    summary TEXT NOT NULL,
    in_degree INTEGER NOT NULL DEFAULT 0,
    out_degree INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, path)
  );
  CREATE TABLE kb_edges (project_id TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (project_id, src, dst));
  CREATE INDEX kb_edges_dst ON kb_edges(project_id, dst);
  CREATE VIRTUAL TABLE kb_fts USING fts5(project_id UNINDEXED, file UNINDEXED, path, symbols, body, tokenize = 'unicode61 remove_diacritics 2');
  CREATE TABLE kb_meta (project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project_id, key));
  `,
  // Tasks can now come from Jira, Slack and Telegram. SQLite cannot alter a CHECK, so the table is rebuilt.
  `
  CREATE TABLE tasks_next (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('manual','linear','github','jira','slack','telegram')),
    source_ref TEXT,
    requester_id TEXT NOT NULL REFERENCES users(id),
    persona TEXT NOT NULL,
    executor TEXT NOT NULL CHECK (executor IN ('claude','codex')),
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL,
    position INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'auto',
    effort TEXT NOT NULL DEFAULT 'auto',
    project_id TEXT
  );
  INSERT INTO tasks_next (id, key, title, description, source, source_ref, requester_id, persona, executor, priority, status, position, snapshot, created_at, updated_at, model, effort, project_id)
    SELECT id, key, title, description, source, source_ref, requester_id, persona, executor, priority, status, position, snapshot, created_at, updated_at, model, effort, project_id FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_next RENAME TO tasks;
  CREATE INDEX tasks_project ON tasks(project_id, position);
  CREATE INDEX tasks_source ON tasks(source, source_ref);
  `,
  // Distributed execution: where a task runs (runtime), its worker lease, and machine credentials.
  // No CHECK on runtime (validated by zod) so new runtimes never need a table rebuild.
  `
  ALTER TABLE tasks ADD COLUMN runtime TEXT NOT NULL DEFAULT 'local';
  ALTER TABLE tasks ADD COLUMN lease_worker TEXT;
  ALTER TABLE tasks ADD COLUMN lease_expires_at INTEGER;
  ALTER TABLE tasks ADD COLUMN lease_seq INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS tasks_runtime_queue ON tasks (runtime, status, position);
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_seen_at INTEGER,
    version TEXT,
    capabilities TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS task_tokens (
    token_hash TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  `,
  // Cluster join (Docker Swarm-like): node availability, how the node was added, and the shared
  // join token (cjt_). Values validated in TS/zod, no CHECK (same rule as tasks.runtime).
  `
  ALTER TABLE workers ADD COLUMN availability TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE workers ADD COLUMN joined_via TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE workers ADD COLUMN hostname TEXT;
  CREATE TABLE IF NOT EXISTS join_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER
  );
  `,
];

/**
 * One-time data move for installs from before multi-project: the single configured repo
 * becomes the first project and owns every existing task and lesson.
 */
function bootstrapProjects(db: DatabaseSync): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
  if (count.n > 0) return;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
  let repoPath = "";
  let baseBranch = "";
  try {
    const parsed = row ? (JSON.parse(row.value) as { repoPath?: string; baseBranch?: string }) : {};
    repoPath = parsed.repoPath ?? "";
    baseBranch = parsed.baseBranch ?? "";
  } catch {
    return;
  }
  if (!repoPath) return;
  const id = randomUUID();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO projects (id, name, repo_path, base_branch, created_at) VALUES (?, ?, ?, ?, ?)").run(id, path.basename(repoPath), repoPath, baseBranch, nowIso());
    db.prepare("UPDATE tasks SET project_id = ? WHERE project_id IS NULL").run(id);
    db.prepare("UPDATE lessons SET project_id = ? WHERE project_id IS NULL").run(id);
    db.prepare("UPDATE users SET active_project_id = ? WHERE active_project_id IS NULL").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Applies pending migrations in order, each in its own transaction. Exported for tests. */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v += 1) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

const globalForDb = globalThis as unknown as { carbonDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (globalForDb.carbonDb) return globalForDb.carbonDb;
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = dbFile(dir);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  migrate(db);
  bootstrapProjects(db);
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort on filesystems without POSIX permissions (e.g. Windows)
  }
  globalForDb.carbonDb = db;
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
