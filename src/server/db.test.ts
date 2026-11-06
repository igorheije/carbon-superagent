import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, MIGRATIONS } from "./db";

/** Schema version right before the integrations migration. */
const BEFORE = 6;

describe("migration: integration task sources", () => {
  it("keeps existing tasks and accepts jira/slack/telegram sources", () => {
    const db = new DatabaseSync(":memory:");
    for (const sql of MIGRATIONS.slice(0, BEFORE)) db.exec(sql);
    db.exec(`PRAGMA user_version = ${BEFORE}`);
    db.exec("INSERT INTO users (id, email, name, password_hash, persona, role, created_at) VALUES ('u1','a@b.c','Ana','x','engineering','admin','2026-01-01')");
    db.exec("INSERT INTO tasks (id, key, title, source, source_ref, requester_id, persona, executor, status, position, snapshot, created_at, updated_at, model, effort, project_id) VALUES ('t1','FRG-1','old','linear','L-1','u1','engineering','claude','done',1,'{}','2026-01-01','2026-01-01','opus','high','p1')");
    expect(() => db.exec("INSERT INTO tasks (id, key, title, source, requester_id, persona, executor, status, position, snapshot, created_at, updated_at) VALUES ('t2','X','x','jira','u1','engineering','claude','queued',2,'{}','x','x')")).toThrow(/CHECK/);

    migrate(db);

    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    expect(db.prepare("SELECT key, source, source_ref, model, effort, project_id FROM tasks WHERE id = 't1'").get()).toEqual({
      key: "FRG-1", source: "linear", source_ref: "L-1", model: "opus", effort: "high", project_id: "p1",
    });
    for (const [id, source] of [["t2", "jira"], ["t3", "slack"], ["t4", "telegram"]]) {
      db.exec(`INSERT INTO tasks (id, key, title, source, requester_id, persona, executor, status, position, snapshot, created_at, updated_at) VALUES ('${id}','K','x','${source}','u1','engineering','claude','queued',2,'{}','x','x')`);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(4);
    expect(() => db.exec("INSERT INTO tasks (id, key, title, source, requester_id, persona, executor, status, position, snapshot, created_at, updated_at) VALUES ('t9','K','x','email','u1','engineering','claude','queued',2,'{}','x','x')")).toThrow(/CHECK/);
  });
});

/** Schema version right before the distributed-execution migration. */
const BEFORE_DISTRIBUTED = 7;

describe("migration: distributed execution", () => {
  it("keeps existing tasks as local and adds leases, workers and task tokens", () => {
    const db = new DatabaseSync(":memory:");
    for (const sql of MIGRATIONS.slice(0, BEFORE_DISTRIBUTED)) db.exec(sql);
    db.exec(`PRAGMA user_version = ${BEFORE_DISTRIBUTED}`);
    db.exec("INSERT INTO users (id, email, name, password_hash, persona, role, created_at) VALUES ('u1','a@b.c','Ana','x','engineering','admin','2026-01-01')");
    db.exec("INSERT INTO tasks (id, key, title, source, source_ref, requester_id, persona, executor, status, position, snapshot, created_at, updated_at, model, effort, project_id) VALUES ('t1','FRG-1','old','jira','J-1','u1','engineering','codex','running',3,'{\"a\":1}','2026-01-01','2026-01-02','opus','high','p1')");

    migrate(db);

    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    expect({ ...(db.prepare("SELECT key, source, executor, status, position, snapshot, model, effort, project_id, runtime, lease_worker, lease_expires_at, lease_seq, cancel_requested FROM tasks WHERE id = 't1'").get() as object) }).toEqual({
      key: "FRG-1", source: "jira", executor: "codex", status: "running", position: 3, snapshot: '{"a":1}', model: "opus", effort: "high", project_id: "p1",
      runtime: "local", lease_worker: null, lease_expires_at: null, lease_seq: 0, cancel_requested: 0,
    });
    const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_runtime_queue'").get();
    expect(index).toBeTruthy();

    db.exec("INSERT INTO workers (id, name, kind, token_hash, created_by, created_at) VALUES ('w1','pc','pool','h1','u1',1)");
    expect({ ...(db.prepare("SELECT capabilities, revoked_at, last_seen_at FROM workers WHERE id = 'w1'").get() as object) }).toEqual({ capabilities: "{}", revoked_at: null, last_seen_at: null });
    expect(() => db.exec("INSERT INTO workers (id, name, kind, token_hash, created_by, created_at) VALUES ('w2','pc2','pool','h1','u1',1)")).toThrow(/UNIQUE/);
    db.exec("INSERT INTO task_tokens (token_hash, task_id, expires_at) VALUES ('th','t1',10)");
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_tokens").get() as { n: number }).n).toBe(1);
  });
});
