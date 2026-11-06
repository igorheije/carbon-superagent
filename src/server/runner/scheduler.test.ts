import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TaskRuntime } from "@/lib/domain/types";
import type { ExecutorId } from "../repo/settings";

const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-scheduler-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

type Modules = {
  db: typeof import("../db");
  tasks: typeof import("../repo/tasks");
  users: typeof import("../repo/users");
  workers: typeof import("../repo/workers");
  scheduler: typeof import("./scheduler");
};
let m: Modules;
let ownerId = "";
const LEASE = 60_000;

beforeAll(async () => {
  m = {
    db: await import("../db"),
    tasks: await import("../repo/tasks"),
    users: await import("../repo/users"),
    workers: await import("../repo/workers"),
    scheduler: await import("./scheduler"),
  };
  ownerId = m.users.createUser({ email: "a@b.c", name: "Ana", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false }).id;
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
// Every test starts from an empty queue.
beforeEach(() => {
  m.db.getDb().exec("DELETE FROM tasks");
});

function newTask(key: string, runtime: TaskRuntime, executor: ExecutorId = "claude") {
  return m.tasks.createTask({
    projectId: "p1", key, title: "t", description: "d", source: "manual", sourceRef: null, requesterId: ownerId, requesterName: "Ana",
    persona: "engineering", executor, model: "auto", effort: "auto", priority: "medium", repo: "r", modelLabel: "x", runtime,
  });
}

/** Runs the exact claim SQL from a separate OS process, with its own SQLite connection. */
function claimInChild(dbFile: string, worker: string): Promise<string | null> {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.DB_FILE);
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare(process.env.CLAIM_SQL).get({ worker: process.env.WORKER, expires: Date.now() + 60000, now: new Date().toISOString(), executors: '["claude"]' });
    db.exec("COMMIT");
    process.stdout.write(row ? row.id : "");
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", "-e", script], {
      env: { ...process.env, DB_FILE: dbFile, CLAIM_SQL: m.scheduler.CLAIM_NEXT_SQL, WORKER: worker },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out || null) : reject(new Error(`claim child exited ${code}: ${err}`))));
  });
}

describe("claimNext", () => {
  it("20 concurrent claims (separate processes) over 5 tasks: 5 claimed, no duplicates", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => newTask(`C-${i}`, "pool").id);
    const dbFile = path.join(m.db.dataDir(), "carbon.db");

    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => claimInChild(dbFile, `w${i}`)));

    const claimed = results.filter((r): r is string => r !== null);
    expect(claimed).toHaveLength(5);
    expect(new Set(claimed).size).toBe(5);
    expect([...claimed].sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const row = m.db.getDb().prepare("SELECT status, lease_worker, json_extract(snapshot, '$.status') AS snap FROM tasks WHERE id = ?").get(id) as { status: string; lease_worker: string; snap: string };
      expect(row).toMatchObject({ status: "running", snap: "running" });
      expect(row.lease_worker).toMatch(/^w\d+$/);
    }
  }, 30_000);

  it("20 claims in-process over 5 tasks: each task leased once, in queue order", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => newTask(`S-${i}`, "pool").id);
    const leases = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => m.scheduler.claimNext(`w${i}`, ["claude"], LEASE, 1000))));
    const claimed = leases.flatMap((l) => (l ? [l.task.id] : []));
    expect(claimed).toEqual(ids);
    expect(leases[0]).toMatchObject({ leaseExpiresAt: 1000 + LEASE, task: { status: "running", runtime: "pool" } });
  });

  it("only takes queued pool tasks whose executor the worker supports", () => {
    newTask("L-1", "local");
    newTask("A-1", "agentcore");
    const codex = newTask("P-1", "pool", "codex");
    expect(m.scheduler.claimNext("w1", ["claude"], LEASE)).toBeNull();
    expect(m.scheduler.claimNext("w1", [], LEASE)).toBeNull();
    expect(m.scheduler.claimNext("w1", ["claude", "codex"], LEASE)?.task.id).toBe(codex.id);
  });
});

describe("claimSpecific", () => {
  it("claims a queued remote task once and never a local one", () => {
    const ac = newTask("AC-1", "agentcore");
    const local = newTask("AC-L", "local");
    expect(m.scheduler.claimSpecific(ac.id, "w1", LEASE)?.task.id).toBe(ac.id);
    expect(m.scheduler.claimSpecific(ac.id, "w2", LEASE)).toBeNull();
    expect(m.scheduler.claimSpecific(local.id, "w1", LEASE)).toBeNull();
    expect(m.scheduler.claimSpecific("missing", "w1", LEASE)).toBeNull();
  });
});

describe("renew / cancel / release", () => {
  it("renews the lease and surfaces a cancel request", () => {
    const t = newTask("R-1", "pool");
    m.scheduler.claimNext("w1", ["claude"], LEASE, 1000);
    expect(m.scheduler.renew(t.id, "w1", LEASE, 2000)).toEqual({ cancel: false });
    expect(m.scheduler.requestCancel(t.id)).toBe(true);
    expect(m.scheduler.renew(t.id, "w1", LEASE, 3000)).toEqual({ cancel: true });
  });

  it("reports lease_lost to another worker, after expiry, and after reassignment", () => {
    const t = newTask("R-2", "pool");
    m.scheduler.claimNext("w1", ["claude"], LEASE, 1000);
    expect(m.scheduler.renew(t.id, "w2", LEASE, 2000)).toBe("lease_lost");
    expect(m.scheduler.renew(t.id, "w1", LEASE, 1000 + LEASE + 1)).toBe("lease_lost");

    expect(m.scheduler.sweepExpiredLeases(1000 + LEASE + 1, { requeue: true })).toEqual([t.id]);
    expect(m.scheduler.claimNext("w2", ["claude"], LEASE, 200_000)?.task.id).toBe(t.id);
    expect(m.scheduler.renew(t.id, "w1", LEASE, 200_001)).toBe("lease_lost");
    expect(m.scheduler.renew(t.id, "w2", LEASE, 200_001)).toEqual({ cancel: false });
  });

  it("does not flag local or unleased tasks for cancel", () => {
    const local = newTask("X-1", "local");
    const queued = newTask("X-2", "pool");
    expect(m.scheduler.requestCancel(local.id)).toBe(false);
    expect(m.scheduler.requestCancel(queued.id)).toBe(false);
  });

  it("releases the lease only for its owner and keeps the status", () => {
    const t = newTask("RL-1", "pool");
    m.scheduler.claimNext("w1", ["claude"], LEASE);
    expect(m.scheduler.releaseLease(t.id, "w2")).toBe(false);
    expect(m.scheduler.releaseLease(t.id, "w1")).toBe(true);
    expect(m.scheduler.renew(t.id, "w1", LEASE)).toBe("lease_lost");
    expect(m.tasks.findTask(t.id)?.status).toBe("running");
  });
});

describe("sweepExpiredLeases", () => {
  it("fails tasks whose worker stopped responding, with a log line naming the worker", () => {
    const worker = m.workers.createWorkerRecord({ name: "pc-sala", kind: "pool", tokenHash: `h-${Date.now()}`, createdBy: ownerId });
    const t = newTask("SW-1", "pool");
    const fresh = newTask("SW-2", "pool");
    m.scheduler.claimNext(worker.id, ["claude"], LEASE, 1000);
    m.scheduler.claimNext("w-other", ["claude"], LEASE, 50_000);

    expect(m.scheduler.sweepExpiredLeases(1000 + LEASE - 1, { requeue: false })).toEqual([]);
    expect(m.scheduler.sweepExpiredLeases(1000 + LEASE + 1, { requeue: false })).toEqual([t.id]);

    const failed = m.tasks.findTask(t.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.snapshot.status).toBe("failed");
    expect(failed?.snapshot.logs.at(-1)).toMatchObject({ level: "warn", text: expect.stringMatching(/worker pc-sala parou de responder/) });
    expect(m.tasks.findTask(fresh.id)?.status).toBe("running");
  });

  it("requeues expired tasks when requested, so another worker can claim them", () => {
    const t = newTask("SW-3", "pool");
    m.scheduler.claimNext("w-gone", ["claude"], LEASE, 1000);
    expect(m.scheduler.sweepExpiredLeases(1000 + LEASE + 1, { requeue: true })).toEqual([t.id]);
    const requeued = m.tasks.findTask(t.id);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.snapshot.logs.at(-1)?.text).toMatch(/parou de responder.*devolvida à fila/);
    expect(m.scheduler.claimNext("w-new", ["claude"], LEASE)?.task.id).toBe(t.id);
  });

  it("never touches local tasks", () => {
    const local = newTask("SW-L", "local");
    m.db.getDb().prepare("UPDATE tasks SET status = 'running', lease_worker = 'x', lease_expires_at = 1 WHERE id = ?").run(local.id);
    expect(m.scheduler.sweepExpiredLeases(Date.now(), { requeue: false })).toEqual([]);
    expect(m.tasks.findTask(local.id)?.status).toBe("running");
  });
});

describe("recoverUnleasedRemoteTasks (boot)", () => {
  it("fails pool tasks left running without a lease (delivery cut by a restart), keeps the rest", () => {
    const stuck = newTask("RB-1", "pool");
    m.scheduler.claimNext("w1", ["claude"], LEASE);
    expect(m.scheduler.releaseLease(stuck.id, "w1")).toBe(true);
    const leased = newTask("RB-2", "pool");
    m.scheduler.claimNext("w2", ["claude"], LEASE);
    const queued = newTask("RB-3", "pool");
    const agentcore = newTask("RB-4", "agentcore");
    m.db.getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(agentcore.id);
    const local = newTask("RB-5", "local");
    m.db.getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(local.id);

    expect(m.scheduler.recoverUnleasedRemoteTasks()).toEqual([stuck.id]);

    const failed = m.tasks.findTask(stuck.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.snapshot.status).toBe("failed");
    expect(failed?.snapshot.logs.at(-1)).toMatchObject({ level: "warn", text: expect.stringContaining("painel reiniciou durante a entrega") });
    expect(m.tasks.findTask(leased.id)?.status).toBe("running");
    expect(m.tasks.findTask(queued.id)?.status).toBe("queued");
    expect(m.tasks.findTask(agentcore.id)?.status).toBe("running");
    expect(m.tasks.findTask(local.id)?.status).toBe("running");
    expect(m.scheduler.recoverUnleasedRemoteTasks()).toEqual([]);
  });
});

describe("local runner", () => {
  it("nextQueuedLocalTask and kick() ignore pool and agentcore tasks", async () => {
    const pool = newTask("K-1", "pool");
    newTask("K-2", "agentcore");
    expect(m.tasks.nextQueuedLocalTask()).toBeNull();

    const runner = await import("./runner");
    runner.kick();
    expect(runner.runnerStatus().activeTaskId).toBeNull();
    expect(m.tasks.findTask(pool.id)?.status).toBe("queued");

    const local = newTask("K-3", "local");
    expect(m.tasks.nextQueuedLocalTask()?.id).toBe(local.id);
  });
});
