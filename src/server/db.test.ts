import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, MIGRATIONS } from "./db";

/** Schema version right before the integrations migration (the last one). */
const BEFORE = MIGRATIONS.length - 1;

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
