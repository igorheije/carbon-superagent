import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import type { ClaimedTask } from "@/shared/worker-protocol";

// Route handlers called directly, real git repos in tmp and a throwaway database.
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-worker-api-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");
process.env.CARBON_WORKER_CLAIM_WAIT_MS = "50";

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@localhost"];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

type Modules = {
  db: typeof import("../db");
  tasks: typeof import("../repo/tasks");
  projects: typeof import("../repo/projects");
  users: typeof import("../repo/users");
  auth: typeof import("../auth/worker-auth");
  live: typeof import("./live");
  scheduler: typeof import("./scheduler");
  prepare: typeof import("./prepare-claim");
  hello: typeof import("@/app/api/worker/hello/route");
  claim: typeof import("@/app/api/worker/claim/route");
  heartbeat: typeof import("@/app/api/worker/tasks/[id]/heartbeat/route");
  events: typeof import("@/app/api/worker/tasks/[id]/events/route");
};
let m: Modules;
let ownerId = "";
let token = "";
let workerId = "";
let otherToken = "";

beforeAll(async () => {
  m = {
    db: await import("../db"),
    tasks: await import("../repo/tasks"),
    projects: await import("../repo/projects"),
    users: await import("../repo/users"),
    auth: await import("../auth/worker-auth"),
    live: await import("./live"),
    scheduler: await import("./scheduler"),
    prepare: await import("./prepare-claim"),
    hello: await import("@/app/api/worker/hello/route"),
    claim: await import("@/app/api/worker/claim/route"),
    heartbeat: await import("@/app/api/worker/tasks/[id]/heartbeat/route"),
    events: await import("@/app/api/worker/tasks/[id]/events/route"),
  };
  ownerId = m.users.createUser({ email: "a@b.c", name: "Ana", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false }).id;
  const created = m.auth.createWorker("maquina-a", "pool", ownerId);
  token = created.token;
  workerId = created.worker.id;
  otherToken = m.auth.createWorker("maquina-b", "pool", ownerId).token;
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
beforeEach(() => {
  m.db.getDb().exec("DELETE FROM tasks");
});

function post(url: string, auth: string | null, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request(`http://127.0.0.1${url}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function json(response: Response): Promise<{ success: boolean; data: unknown; error: string | null }> {
  return (await response.json()) as { success: boolean; data: unknown; error: string | null };
}

function repo(name: string): string {
  const dir = path.join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "# projeto\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Repo with an origin whose main exists as a remote-tracking ref. */
function repoWithRemote(name: string): string {
  const dir = repo(name);
  const bare = path.join(sandbox, `${name}.git`);
  git(sandbox, "init", "-q", "--bare", bare);
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "-u", "origin", "main");
  git(dir, "fetch", "-q", "origin");
  return dir;
}

function poolTask(repoPath: string, key = "CAR-1") {
  const project = m.projects.findProjectByRepo(repoPath) ?? m.projects.createProject({ name: path.basename(repoPath), repoPath, baseBranch: "main" });
  return m.tasks.createTask({
    projectId: project.id, key, title: "Corrigir rodapé", description: "ajustar o texto do rodapé", source: "manual", sourceRef: null,
    requesterId: ownerId, requesterName: "Ana", persona: "engineering", executor: "claude", model: "auto", effort: "auto",
    priority: "medium", repo: "r", modelLabel: "x", runtime: "pool",
  });
}

async function claim(auth = token): Promise<Response> {
  return m.claim.POST(post("/api/worker/claim", auth, { executors: ["claude"] }));
}

describe("auth", () => {
  it("401 without a token", async () => {
    const response = await m.hello.POST(post("/api/worker/hello", null, { version: 1 }));
    expect(response.status).toBe(401);
  });

  it("401 with a revoked token", async () => {
    const revoked = m.auth.createWorker("revogada", "pool", ownerId);
    m.auth.revokeWorker(revoked.worker.id);
    const response = await m.hello.POST(post("/api/worker/hello", revoked.token, { version: 1 }));
    expect(response.status).toBe(401);
  });

  it("401 on every worker route, not only hello", async () => {
    expect((await m.claim.POST(post("/api/worker/claim", null, { executors: ["claude"] }))).status).toBe(401);
    expect((await m.heartbeat.POST(post("/api/worker/tasks/x/heartbeat", null), params("x"))).status).toBe(401);
    expect((await m.events.POST(post("/api/worker/tasks/x/events", null, { seq: 1, events: [] }), params("x"))).status).toBe(401);
  });
});

describe("hello", () => {
  it("426 when the worker speaks an older protocol", async () => {
    const response = await m.hello.POST(post("/api/worker/hello", token, { version: 0 }));
    expect(response.status).toBe(426);
  });

  it("returns protocol and default timings, and records capabilities", async () => {
    const response = await m.hello.POST(post("/api/worker/hello", token, { version: 1, executors: ["claude"], git: true, maxParallel: 2, workerVersion: "0.3.0" }));
    expect(response.status).toBe(200);
    expect((await json(response)).data).toEqual({ protocol: 1, leaseMs: 60_000, pollMs: 25_000, availability: "active" });
    const { findWorker } = await import("../repo/workers");
    const worker = findWorker(workerId);
    expect(worker?.version).toBe("0.3.0");
    expect(worker?.capabilities).toEqual({ executors: ["claude"], git: true, maxParallel: 2 });
  });

  it("400 on an invalid body and 413 above 1 MB", async () => {
    expect((await m.hello.POST(post("/api/worker/hello", token, { version: "x" }))).status).toBe(400);
    const big = post("/api/worker/hello", token, { version: 1, pad: "x".repeat(1024 * 1024 + 10) });
    expect((await m.hello.POST(big)).status).toBe(413);
  });
});

describe("claim", () => {
  it("429 above max(parallel,1)+1 concurrent long-polls of one worker (M5), and the slots free up", async () => {
    // maxParallel unknown (no hello yet) → 1 slot → 2 polls at once.
    const fresh = m.auth.createWorker("m5-a", "pool", ownerId).token;
    const responses = await Promise.all([claim(fresh), claim(fresh), claim(fresh)]);
    expect(responses.map((r) => r.status).sort()).toEqual([204, 204, 429]);
    expect((await claim(fresh)).status).toBe(204);
    // A worker that declared 3 slots may hold 4 polls.
    const wideToken = m.auth.createWorker("m5-b", "pool", ownerId).token;
    await m.hello.POST(post("/api/worker/hello", wideToken, { version: 1, executors: ["claude"], git: false, maxParallel: 3 }));
    const wide = await Promise.all(Array.from({ length: 5 }, () => claim(wideToken)));
    expect(wide.filter((r) => r.status === 429)).toHaveLength(1);
  });

  it("204 when the queue is empty", async () => {
    const started = Date.now();
    const response = await claim();
    expect(response.status).toBe(204);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("bundle transport for a repo without a remote", async () => {
    const dir = repo("sem-remoto");
    const task = poolTask(dir);
    const response = await claim();
    expect(response.status).toBe(200);
    const claimed = (await json(response)).data as ClaimedTask;
    expect(claimed.taskId).toBe(task.id);
    expect(claimed.leaseMs).toBe(60_000);
    expect(claimed.code).toEqual({
      transport: "bundle",
      baseRef: "main",
      branch: m.prepare.taskBranch(task),
      bundleUrl: `/api/worker/tasks/${task.id}/bundle`,
    });
    expect(claimed.code.branch).toMatch(/^agent\/car-1-/);
    expect(claimed.prompt).toContain("Corrigir rodapé");
    expect(claimed.resume).toBeNull();
    expect(claimed.limits.maxRunMinutes).toBe(45);
    expect(claimed.settings.permissionProfile).toBe("guarded");

    const ticket = m.tasks.findTask(task.id)?.snapshot as Ticket;
    expect(ticket.status).toBe("running");
    expect(ticket.workspace?.branch).toBe(claimed.code.branch);
    expect(ticket.logs.some((l) => l.text === "worker maquina-a assumiu a tarefa")).toBe(true);
  });

  it("git transport for a repo with a remote, without credentials in the URL", async () => {
    const dir = repoWithRemote("com-remoto");
    git(dir, "remote", "set-url", "origin", "https://user:s3cr3t@example.com/org/repo.git");
    poolTask(dir, "CAR-2");
    const claimed = (await json(await claim())).data as ClaimedTask;
    expect(claimed.code).toEqual({
      transport: "git",
      remoteUrl: "https://example.com/org/repo.git",
      baseRef: "main",
      branch: claimed.code.branch,
    });
    expect(JSON.stringify(claimed)).not.toContain("s3cr3t");
  });

  it("does not hand the same task to two workers", async () => {
    poolTask(repo("disputa"));
    const [a, b] = await Promise.all([claim(token), claim(otherToken)]);
    expect([a.status, b.status].sort()).toEqual([200, 204]);
  });
});

describe("heartbeat and events", () => {
  async function claimedTask(): Promise<ClaimedTask> {
    poolTask(repo(`hb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`));
    return (await json(await claim())).data as ClaimedTask;
  }

  it("renews the lease and reports cancel", async () => {
    const claimed = await claimedTask();
    const first = await m.heartbeat.POST(post(`/api/worker/tasks/${claimed.taskId}/heartbeat`, token), params(claimed.taskId));
    expect((await json(first)).data).toEqual({ cancel: false });
    m.scheduler.requestCancel(claimed.taskId);
    const second = await m.heartbeat.POST(post(`/api/worker/tasks/${claimed.taskId}/heartbeat`, token), params(claimed.taskId));
    expect((await json(second)).data).toEqual({ cancel: true });
  });

  it("409 lease_lost for a worker that does not hold the lease", async () => {
    const claimed = await claimedTask();
    const response = await m.heartbeat.POST(post(`/api/worker/tasks/${claimed.taskId}/heartbeat`, otherToken), params(claimed.taskId));
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe("lease_lost");
  });

  it("409 lease_lost after the lease expired and was swept", async () => {
    const claimed = await claimedTask();
    m.scheduler.sweepExpiredLeases(Date.now() + 120_000, { requeue: false });
    const response = await m.heartbeat.POST(post(`/api/worker/tasks/${claimed.taskId}/heartbeat`, token), params(claimed.taskId));
    expect(response.status).toBe(409);
  });

  it("applies events, updates the snapshot, emits change and ignores a repeated seq", async () => {
    const claimed = await claimedTask();
    let changes = 0;
    const onChange = () => {
      changes += 1;
    };
    m.live.liveEvents().on("change", onChange);
    const batch = { seq: 1, events: [{ type: "text", text: "lendo o rodapé\nCARBON_PLAN: ajustar texto" }, { type: "usage", tokens: 100, costUsd: 0.01 }] };
    try {
      const url = `/api/worker/tasks/${claimed.taskId}/events`;
      const first = await m.events.POST(post(url, token, batch), params(claimed.taskId));
      expect((await json(first)).data).toEqual({ acceptedSeq: 1 });
      expect(changes).toBe(1);
      const after = m.tasks.findTask(claimed.taskId)?.snapshot as Ticket;
      expect(after.logs.some((l) => l.text.includes("lendo o rodapé"))).toBe(true);
      expect(after.tokens).toBe(100);

      const retry = await m.events.POST(post(url, token, batch), params(claimed.taskId));
      expect((await json(retry)).data).toEqual({ acceptedSeq: 1 });
      expect(changes).toBe(1);
      expect((m.tasks.findTask(claimed.taskId)?.snapshot as Ticket).tokens).toBe(100);

      const next = await m.events.POST(post(url, token, { seq: 2, events: [{ type: "usage", tokens: 5, costUsd: null }] }), params(claimed.taskId));
      expect((await json(next)).data).toEqual({ acceptedSeq: 2 });
      expect((m.tasks.findTask(claimed.taskId)?.snapshot as Ticket).tokens).toBe(105);
    } finally {
      m.live.liveEvents().off("change", onChange);
    }
  });

  it("keeps the marker plan across batches", async () => {
    const claimed = await claimedTask();
    const url = `/api/worker/tasks/${claimed.taskId}/events`;
    await m.events.POST(post(url, token, { seq: 1, events: [{ type: "text", text: "CARBON_PLAN: passo um" }] }), params(claimed.taskId));
    await m.events.POST(post(url, token, { seq: 2, events: [{ type: "text", text: "CARBON_PLAN: passo dois" }] }), params(claimed.taskId));
    const plan = (m.tasks.findTask(claimed.taskId)?.snapshot as Ticket).plan.map((s) => s.text);
    expect(plan).toEqual(["passo um", "passo dois"]);
  });

  it("409 for events from a worker that is not the lease owner", async () => {
    const claimed = await claimedTask();
    const response = await m.events.POST(post(`/api/worker/tasks/${claimed.taskId}/events`, otherToken, { seq: 1, events: [] }), params(claimed.taskId));
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe("lease_lost");
  });

  it("400 for an event that does not match the protocol", async () => {
    const claimed = await claimedTask();
    const response = await m.events.POST(post(`/api/worker/tasks/${claimed.taskId}/events`, token, { seq: 1, events: [{ type: "bogus" }] }), params(claimed.taskId));
    expect(response.status).toBe(400);
  });
});
