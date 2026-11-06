import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskRuntime } from "@/lib/domain/types";

const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-tasks-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

let tasks: typeof import("./tasks");
let ownerId = "";

beforeAll(async () => {
  tasks = await import("./tasks");
  const users = await import("./users");
  ownerId = users.createUser({ email: "a@b.c", name: "Ana", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false }).id;
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function newTask(key: string, runtime?: TaskRuntime) {
  return tasks.createTask({
    projectId: "p1", key, title: "t", description: "d", source: "manual", sourceRef: null, requesterId: ownerId, requesterName: "Ana",
    persona: "engineering", executor: "claude", model: "auto", effort: "auto", priority: "medium", repo: "r", modelLabel: "x",
    ...(runtime ? { runtime } : {}),
  });
}

describe("task runtime", () => {
  it("defaults to local and stores the requested runtime on the row and the snapshot", () => {
    const local = newTask("RT-1");
    expect(local.runtime).toBe("local");
    expect(local.snapshot.runtime).toBe("local");
    const pool = newTask("RT-2", "pool");
    expect(pool.runtime).toBe("pool");
    expect(tasks.findTask(pool.id)?.snapshot.runtime).toBe("pool");
  });
});

describe("recoverInterruptedTasks", () => {
  it("fails only local running tasks, leaving remote ones to the scheduler", () => {
    const local = newTask("RC-1");
    const pool = newTask("RC-2", "pool");
    const agentcore = newTask("RC-3", "agentcore");
    for (const t of [local, pool, agentcore]) tasks.saveSnapshot(t.id, { ...t.snapshot, status: "running" });

    tasks.recoverInterruptedTasks();

    expect(tasks.findTask(local.id)?.status).toBe("failed");
    expect(tasks.findTask(local.id)?.snapshot.logs.at(-1)?.text).toMatch(/reiniciou/);
    expect(tasks.findTask(pool.id)?.status).toBe("running");
    expect(tasks.findTask(agentcore.id)?.status).toBe("running");
  });
});
