import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import { NO_COMMITS_REF, type ClaimedTask } from "@/shared/worker-protocol";
import { createWorkerClient, type FetchLike, type WorkerClient } from "./client";
import { runClaimedTask, type RunOutcome } from "./run-task";

// Integration: REAL panel route handlers (in-process), REAL scheduler + SQLite in a temp
// CARBON_DATA_DIR, the T8 client with a fetch that dispatches to those handlers, the T9 code
// transport with real git, and a fake executor (node script printing Claude-style JSONL).
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-run-task-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");
process.env.CARBON_WORKER_CLAIM_WAIT_MS = "50";

/** Minimum lease the settings accept: heartbeat every ~3.3 s. */
const LEASE_MS = 10_000;
const HEARTBEAT_MS = LEASE_MS / 3;

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const FAKE_AGENT = `
import { writeFileSync } from "node:fs";
const mode = process.argv[2];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const say = (text) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });
out({ type: "system", subtype: "init", session_id: "sess-fake", model: "fake-model" });
say("CARBON_PLAN: alterar app.txt");
if (mode === "fail") {
  process.stderr.write("boom: falha simulada\\n");
  process.exit(3);
}
if (mode === "hang") {
  say("trabalhando sem parar");
  setInterval(() => undefined, 1000);
} else {
  if (mode === "big") say("x".repeat(70_000));
  if (mode !== "noop") {
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: process.cwd() + "/app.txt" } }] } });
    writeFileSync("app.txt", "linha 1 alterada pelo agente\\n");
  }
  say("CARBON_DONE: 1");
  out({ type: "result", subtype: "success", is_error: false, result: "feito", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } });
}
`;

type Modules = {
  db: typeof import("@/server/db");
  tasks: typeof import("@/server/repo/tasks");
  projects: typeof import("@/server/repo/projects");
  users: typeof import("@/server/repo/users");
  settings: typeof import("@/server/repo/settings");
  auth: typeof import("@/server/auth/worker-auth");
  local: typeof import("@/server/runner/local-delivery");
  scheduler: typeof import("@/server/runner/scheduler");
  hello: typeof import("@/app/api/worker/hello/route");
  claim: typeof import("@/app/api/worker/claim/route");
  heartbeat: typeof import("@/app/api/worker/tasks/[id]/heartbeat/route");
  events: typeof import("@/app/api/worker/tasks/[id]/events/route");
  bundle: typeof import("@/app/api/worker/tasks/[id]/bundle/route");
  result: typeof import("@/app/api/worker/tasks/[id]/result/route");
};
let m: Modules;
let ownerId = "";
let agentScript = "";
let counter = 0;

beforeAll(async () => {
  m = {
    db: await import("@/server/db"),
    tasks: await import("@/server/repo/tasks"),
    projects: await import("@/server/repo/projects"),
    users: await import("@/server/repo/users"),
    settings: await import("@/server/repo/settings"),
    auth: await import("@/server/auth/worker-auth"),
    local: await import("@/server/runner/local-delivery"),
    scheduler: await import("@/server/runner/scheduler"),
    hello: await import("@/app/api/worker/hello/route"),
    claim: await import("@/app/api/worker/claim/route"),
    heartbeat: await import("@/app/api/worker/tasks/[id]/heartbeat/route"),
    events: await import("@/app/api/worker/tasks/[id]/events/route"),
    bundle: await import("@/app/api/worker/tasks/[id]/bundle/route"),
    result: await import("@/app/api/worker/tasks/[id]/result/route"),
  };
  ownerId = m.users.createUser({ email: "a@b.c", name: "Ana", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false }).id;
  agentScript = path.join(sandbox, "fake-agent.mjs");
  writeFileSync(agentScript, FAKE_AGENT);
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
beforeEach(() => {
  m.db.getDb().exec("DELETE FROM tasks");
  m.settings.saveSettings({ autoPush: false, workers: { leaseMs: LEASE_MS, pollMs: 25_000, requeueOnLeaseLoss: false, maxBundleMb: 200 } });
});

// ---------------------------------------------------------------- in-process panel

const TASK_ROUTE = /^\/api\/worker\/tasks\/([^/]+)\/(heartbeat|events|bundle|result)$/;

/** fetch → the exported route handlers. Records "METHOD /path" for every call. */
function panelFetch(calls: string[]): FetchLike {
  return async (url, init = {}) => {
    const request = new Request(url, init);
    const { pathname } = new URL(url);
    calls.push(`${request.method} ${pathname}`);
    if (pathname === "/api/worker/hello") return m.hello.POST(request);
    if (pathname === "/api/worker/claim") return m.claim.POST(request);
    const match = TASK_ROUTE.exec(pathname);
    if (!match) return new Response(null, { status: 404 });
    const ctx = { params: Promise.resolve({ id: decodeURIComponent(match[1] ?? "") }) };
    switch (match[2]) {
      case "heartbeat":
        return m.heartbeat.POST(request, ctx);
      case "events":
        return m.events.POST(request, ctx);
      case "bundle":
        return request.method === "PUT" ? m.bundle.PUT(request, ctx) : m.bundle.GET(request, ctx);
      default:
        return m.result.POST(request, ctx);
    }
  };
}

interface Harness {
  readonly client: WorkerClient;
  readonly calls: string[];
  readonly workDir: string;
}

function harness(): Harness {
  const calls: string[] = [];
  const { token } = m.auth.createWorker(unique("maquina"), "pool", ownerId);
  const client = createWorkerClient({ panelUrl: "http://panel.test", token, fetchImpl: panelFetch(calls) });
  return { client, calls, workDir: path.join(sandbox, unique("work")) };
}

// ---------------------------------------------------------------- repos and tasks

const unique = (name: string) => `${name}-${(counter += 1)}`;

function repo(name: string, withCommit = true): string {
  const dir = path.join(sandbox, unique(name));
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "# projeto\n");
  writeFileSync(path.join(dir, "app.txt"), "linha 1\n");
  if (withCommit) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

function repoWithRemote(name: string): { dir: string; bare: string } {
  const dir = repo(name);
  const bare = `${dir}.git`;
  git(sandbox, "init", "-q", "--bare", bare);
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "-u", "origin", "main");
  git(dir, "fetch", "-q", "origin");
  return { dir, bare };
}

function poolTask(repoPath: string) {
  const project = m.projects.createProject({ name: path.basename(repoPath), repoPath, baseBranch: "main" });
  return m.tasks.createTask({
    projectId: project.id, key: "CAR-11", title: "Ajustar app", description: "trocar a linha do app", source: "manual", sourceRef: null,
    requesterId: ownerId, requesterName: "Ana", persona: "engineering", executor: "claude", model: "auto", effort: "auto",
    priority: "medium", repo: "r", modelLabel: "x", runtime: "pool",
  });
}

const ticketOf = (taskId: string) => m.tasks.findTask(taskId)?.snapshot as Ticket;
const leaseOf = (taskId: string) =>
  m.db.getDb().prepare("SELECT lease_worker FROM tasks WHERE id = ?").get(taskId) as { lease_worker: string | null };

async function claimOne(h: Harness): Promise<ClaimedTask> {
  const claimed = await h.client.claim(["claude"]);
  if (!claimed) throw new Error("nada para fazer claim");
  return claimed;
}

function run(h: Harness, claimed: ClaimedTask, mode: string, logs: string[] = []): Promise<RunOutcome> {
  return runClaimedTask(claimed, {
    client: h.client,
    workDir: h.workDir,
    executorOverride: (command) => ({ ...command, bin: process.execPath, args: [agentScript, mode] }),
    log: (line) => logs.push(line),
  });
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condição não atingida a tempo");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const hasLog = (taskId: string, text: string) => (ticketOf(taskId)?.logs ?? []).some((l) => l.text.includes(text));

// ---------------------------------------------------------------- tests

describe("runClaimedTask — bundle transport", () => {
  it("repo WITHOUT commits: done, branch imported, oversized text clipped, 'apply to folder' works", async () => {
    const h = harness();
    expect(await h.client.hello({ executors: ["claude"], git: true, maxParallel: 1 })).toMatchObject({ protocol: 1, leaseMs: LEASE_MS });
    const dir = repo("sem-commits", false);
    const task = poolTask(dir);
    const claimed = await claimOne(h);
    expect(claimed.code).toMatchObject({ transport: "bundle", baseRef: NO_COMMITS_REF });

    expect(await run(h, claimed, "big")).toBe("done");

    const ticket = ticketOf(task.id);
    expect(ticket.status).toBe("done");
    expect(ticket.diff.map((d) => d.path)).toEqual(["app.txt"]);
    expect(ticket.sessionId).toBe("sess-fake");
    expect(git(dir, "show", `${claimed.code.branch}:app.txt`)).toBe("linha 1 alterada pelo agente");
    expect(leaseOf(task.id).lease_worker).toBeNull();
    expect(h.calls).toContain(`PUT /api/worker/tasks/${task.id}/bundle`);
    expect(readdirSync(h.workDir)).toEqual([]);

    expect(await m.local.applyToWorkingDir(task.id, "Ana")).toMatchObject({ ok: true });
    expect(readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("linha 1 alterada pelo agente\n");
  });

  it("repo WITH commits but no remote: done, branch imported on top of main, 'apply to folder' works", async () => {
    const h = harness();
    const dir = repo("sem-remoto");
    const task = poolTask(dir);
    const claimed = await claimOne(h);
    expect(claimed.code).toMatchObject({ transport: "bundle", baseRef: "main" });

    expect(await run(h, claimed, "edit")).toBe("done");

    expect(ticketOf(task.id).status).toBe("done");
    expect(git(dir, "rev-parse", `${claimed.code.branch}~1`)).toBe(git(dir, "rev-parse", "main"));
    expect(ticketOf(task.id).diff).toEqual([expect.objectContaining({ path: "app.txt", additions: 1, deletions: 1 })]);
    expect(await m.local.applyToWorkingDir(task.id, "Ana")).toMatchObject({ ok: true });
    expect(readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("linha 1 alterada pelo agente\n");
  });

  it("agent without changes: done with nothing to deliver, no branch (same as the local runner)", async () => {
    const h = harness();
    const dir = repo("sem-mudanca");
    const task = poolTask(dir);
    const claimed = await claimOne(h);

    expect(await run(h, claimed, "noop")).toBe("done");

    expect(ticketOf(task.id).status).toBe("done");
    expect(hasLog(task.id, "nada a entregar")).toBe(true);
    expect(git(dir, "branch", "--list", claimed.code.branch)).toBe("");
  });
});

describe("runClaimedTask — git transport", () => {
  it("clones from the bare remote, pushes the branch and the panel fetches it", async () => {
    const h = harness();
    const { dir, bare } = repoWithRemote("com-remoto");
    const task = poolTask(dir);
    const claimed = await claimOne(h);
    expect(claimed.code).toMatchObject({ transport: "git", remoteUrl: bare, baseRef: "main" });

    expect(await run(h, claimed, "edit")).toBe("done");

    const pushed = git(bare, "rev-parse", claimed.code.branch);
    expect(git(dir, "rev-parse", claimed.code.branch)).toBe(pushed);
    expect(ticketOf(task.id).status).toBe("done");
    expect(h.calls.some((c) => c.includes("/bundle"))).toBe(false);
  });
});

describe("runClaimedTask — stop conditions", () => {
  it("cancel in the panel stops the agent within one heartbeat interval and reports canceled", async () => {
    const h = harness();
    const task = poolTask(repo("cancelar"));
    const claimed = await claimOne(h);
    const outcome = run(h, claimed, "hang");
    await until(() => hasLog(task.id, "trabalhando sem parar"));

    const asked = Date.now();
    expect(m.scheduler.requestCancel(task.id)).toBe(true);
    expect(await outcome).toBe("canceled");
    expect(Date.now() - asked).toBeLessThan(HEARTBEAT_MS + 2_000);

    const ticket = ticketOf(task.id);
    expect(ticket.status).toBe("failed");
    expect(hasLog(task.id, "cancelado: pedido no painel")).toBe(true);
    expect(leaseOf(task.id).lease_worker).toBeNull();
    expect(readdirSync(h.workDir)).toEqual([]);
  }, 20_000);

  it("lease lost: stops the agent and never posts a result", async () => {
    const h = harness();
    const dir = repo("lease");
    const task = poolTask(dir);
    const claimed = await claimOne(h);
    const outcome = run(h, claimed, "hang");
    await until(() => hasLog(task.id, "trabalhando sem parar"));

    // The panel gives up on the worker (as if its lease had expired).
    expect(m.scheduler.sweepExpiredLeases(Date.now() + LEASE_MS * 2, { requeue: false })).toEqual([task.id]);
    expect(await outcome).toBe("lease_lost");

    expect(h.calls.some((c) => c.endsWith("/result"))).toBe(false);
    expect(ticketOf(task.id).status).toBe("failed");
    expect(hasLog(task.id, "parou de responder")).toBe(true);
    expect(git(dir, "branch", "--list", claimed.code.branch)).toBe("");
    expect(readdirSync(h.workDir)).toEqual([]);
  }, 20_000);

  it("executor failure: failed, with the error event in the log", async () => {
    const h = harness();
    const task = poolTask(repo("falha"));
    const claimed = await claimOne(h);

    expect(await run(h, claimed, "fail")).toBe("failed");

    const ticket = ticketOf(task.id);
    expect(ticket.status).toBe("failed");
    expect(ticket.logs.filter((l) => l.text.includes("agente saiu com código 3: boom: falha simulada")).length).toBeGreaterThanOrEqual(2);
    expect(leaseOf(task.id).lease_worker).toBeNull();
  });
});
