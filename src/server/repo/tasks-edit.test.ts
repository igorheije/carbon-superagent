import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskRuntime, Ticket } from "@/lib/domain/types";

const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-task-edit-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

let tasks: typeof import("./tasks");
let ownerId = "";

beforeAll(async () => {
  tasks = await import("./tasks");
  const users = await import("./users");
  ownerId = users.createUser({ email: "e@d.it", name: "Edu", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false }).id;
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function newTask(title: string, runtime: TaskRuntime = "local", distributed = false) {
  return tasks.createTask({
    projectId: "p1",
    key: null,
    title,
    description: "original",
    source: "manual",
    sourceRef: null,
    requesterId: ownerId,
    requesterName: "Edu",
    persona: "engineering",
    executor: "claude",
    model: "auto",
    effort: "auto",
    modelLabel: "Claude Code",
    priority: "medium",
    repo: "repo",
    runtime,
    distributed,
  });
}

const withStatus = (id: string, status: Ticket["status"]) => {
  const task = tasks.findTask(id);
  if (task) tasks.saveSnapshot(id, { ...task.snapshot, status });
};

describe("editTask", () => {
  it("changes title, description and where it runs of a finished task (columns and snapshot)", () => {
    const task = newTask("Post de Natal");
    withStatus(task.id, "done");

    expect(tasks.editTask(task.id, { title: "Post de Natal com carrossel", description: "3 slides", runtime: "pool" })).toBe("ok");

    const edited = tasks.findTask(task.id);
    expect(edited).toMatchObject({ title: "Post de Natal com carrossel", description: "3 slides", runtime: "pool", status: "done" });
    expect(edited?.snapshot).toMatchObject({ title: "Post de Natal com carrossel", runtime: "pool" });
  });

  it("refuses while the task runs or waits for an answer", () => {
    const running = newTask("rodando");
    withStatus(running.id, "running");
    const waiting = newTask("esperando");
    withStatus(waiting.id, "waiting");

    expect(tasks.editTask(running.id, { title: "x y z", description: "" })).toBe("busy");
    expect(tasks.editTask(waiting.id, { title: "x y z", description: "" })).toBe("busy");
    expect(tasks.findTask(running.id)?.title).toBe("rodando");
  });

  it("keeps a distributed task on this machine and reports a missing task", () => {
    const task = newTask("dividir", "local", true);

    expect(tasks.editTask(task.id, { title: "dividir melhor", description: "", runtime: "pool" })).toBe("ok");
    expect(tasks.findTask(task.id)?.runtime).toBe("local");
    expect(tasks.editTask("nope", { title: "abc", description: "" })).toBe("not_found");
  });
});
