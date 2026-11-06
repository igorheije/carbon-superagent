import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import type { ExecutorEvent } from "../executors/events";

const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-remote-perms-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

type Modules = {
  rp: typeof import("./remote-permissions");
  apply: typeof import("./apply");
  db: typeof import("../db");
  tasks: typeof import("../repo/tasks");
  projects: typeof import("../repo/projects");
  users: typeof import("../repo/users");
  scheduler: typeof import("./scheduler");
};
let m: Modules;

beforeAll(async () => {
  m = {
    rp: await import("./remote-permissions"),
    apply: await import("./apply"),
    db: await import("../db"),
    tasks: await import("../repo/tasks"),
    projects: await import("../repo/projects"),
    users: await import("../repo/users"),
    scheduler: await import("./scheduler"),
  };
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const request = (requestId: string, command = "make deploy"): Extract<ExecutorEvent, { type: "permission_request" }> => ({
  type: "permission_request", requestId, tool: "Bash", summary: command, detail: command, input: { command }, suggestions: [],
});

function baseTicket(): Ticket {
  return {
    id: "t1", key: "CAR-1", title: "x", source: "github", repo: "r", requester: "Ana", priority: "medium", status: "running", stage: "code",
    cursor: 0, totalEvents: 0, plan: [], logs: [], hits: [], diff: [], findings: [], tests: null, pr: null, tokens: 0, model: null,
    startedAtTick: null, endedAtTick: null,
  };
}

/** What event ingestion does: apply the event, then register the prompt. */
const ingest = (ticket: Ticket, requestId: string, now = 1_000) => {
  const event = request(requestId);
  const applied = m.apply.applyExecutorEvent(ticket, m.apply.emptyContext, event).ticket;
  return m.rp.registerRemotePrompt(applied, event, now);
};

describe("remote permission bookkeeping (pure)", () => {
  it("a forwarded prompt is pending, with the rule pattern and no raw input", () => {
    const ticket = ingest(baseTicket(), "r1");
    expect(ticket.status).toBe("waiting");
    expect(m.rp.remoteState(ticket).pending).toEqual([{ requestId: "r1", tool: "Bash", pattern: "make deploy", askedAt: 1_000 }]);
    expect(JSON.stringify(m.rp.remoteState(ticket))).not.toContain("input");
  });

  it("expires only overdue prompts and queues a deny for the worker", () => {
    const ticket = ingest(ingest(baseTicket(), "old", 0), "new", 10 * 60_000);
    const expired = m.rp.expireOverdue(ticket, 15, 15 * 60_000);
    expect(m.rp.remoteState(expired).pending.map((p) => p.requestId)).toEqual(["new"]);
    expect(m.rp.decisionsAfter(expired, 0)).toEqual([expect.objectContaining({ seq: 1, requestId: "old", behavior: "deny", allowTask: false })]);
    expect(expired.status).toBe("waiting");
    expect(m.rp.expireOverdue(ticket, 15, 1)).toBe(ticket);
  });

  it("after 'allow all', a prompt that still arrives is allowed on the spot", () => {
    const allowAll = { ...baseTicket(), remotePermissions: { seq: 3, allowAll: true, pending: [], decisions: [] } } as Ticket;
    const ticket = ingest(allowAll, "r9");
    expect(ticket.status).toBe("running");
    expect(ticket.permissions?.[0]).toMatchObject({ status: "allowed", decidedBy: "tudo liberado nesta tarefa" });
    expect(m.rp.decisionsAfter(ticket, 3)).toEqual([expect.objectContaining({ seq: 4, behavior: "allow", requestId: "r9" })]);
  });

  it("closing a run marks open prompts expired and clears the pending list", () => {
    const closed = m.rp.closeRemotePrompts(ingest(baseTicket(), "r1"));
    expect(closed.permissions?.[0]?.status).toBe("expired");
    expect(m.rp.remoteState(closed).pending).toEqual([]);
  });
});

describe("remote permission bookkeeping (DB)", () => {
  it("a new claim drops the previous run's state; a swept lease closes open prompts", () => {
    const owner = m.users.createUser({ email: "a@b.c", name: "Ana", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false }).id;
    const repoPath = path.join(sandbox, "repo");
    mkdirSync(repoPath, { recursive: true });
    const project = m.projects.createProject({ name: "repo", repoPath, baseBranch: "main" });
    const task = m.tasks.createTask({
      projectId: project.id, key: "CAR-2", title: "x", description: "y", source: "manual", sourceRef: null, requesterId: owner, requesterName: "Ana",
      persona: "engineering", executor: "claude", model: "auto", effort: "auto", priority: "medium", repo: "r", modelLabel: "x", runtime: "pool",
    });
    m.tasks.saveSnapshot(task.id, { ...ingest(task.snapshot, "r1"), status: "queued" });

    const lease = m.scheduler.claimNext("w1", ["claude"], 10_000, 1_000);
    expect(lease?.task.id).toBe(task.id);
    expect(m.rp.remoteState(lease?.task.snapshot as Ticket)).toEqual({ seq: 0, allowAll: false, pending: [], decisions: [] });

    m.tasks.saveSnapshot(task.id, ingest(m.tasks.findTask(task.id)?.snapshot as Ticket, "r2"));
    expect(m.scheduler.sweepExpiredLeases(1_000_000, { requeue: false })).toEqual([task.id]);
    const swept = m.tasks.findTask(task.id)?.snapshot as Ticket;
    expect(swept.status).toBe("failed");
    expect(swept.permissions?.find((p) => p.id === "r2")?.status).toBe("expired");
  });
});
