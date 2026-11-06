import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import type { ClaimedTask } from "@/shared/worker-protocol";
import { createWorkerClient, type FetchLike, type WorkerClient } from "./client";
import { runClaimedTask, type RunOutcome } from "./run-task";

// Integration (RMT-01, RMT-02): REAL panel routes in-process, REAL SQLite in a temp
// CARBON_DATA_DIR, the real worker client and run-task, and a fake Claude CLI that asks for a
// permission over the stream-json control protocol or prints a CARBON_QUESTION.
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-remote-hitl-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");
process.env.CARBON_WORKER_CLAIM_WAIT_MS = "50";
process.env.CARBON_WORKER_PERMISSION_WAIT_MS = "200";

const LEASE_MS = 10_000;
const TIMEOUT_MINUTES = 15;

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * Fake `claude -p --input-format stream-json`: reads the prompt from stdin, then per mode:
 * ask  → one permission request (Bash "make deploy"); allowed → edits app.txt.
 * ask2 → two identical requests in a row; edits app.txt once per allow.
 * question → prints a CARBON_QUESTION and ends successfully.
 * edit → edits app.txt (the run after the answer). The prompt is written to argv[3].
 */
const FAKE_AGENT = `
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mode = process.argv[2];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const say = (text) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });
const finish = () => {
  say("CARBON_DONE: 1");
  out({ type: "result", subtype: "success", is_error: false, result: "feito", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } });
};
const lines = createInterface({ input: process.stdin });
const next = () => new Promise((resolve) => lines.once("line", (line) => resolve(JSON.parse(line))));
const ask = async (id) => {
  out({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "make deploy" }, permission_suggestions: [] } });
  const reply = await next();
  const response = reply.response.response;
  if (response.behavior === "allow") {
    appendFileSync("app.txt", "deploy " + id + " (" + response.updatedInput.command + ")\\n");
    say("permitido " + id);
  } else {
    say("negado " + id + ": " + response.message);
  }
};
const first = await next();
writeFileSync(process.argv[3], first.message.content);
out({ type: "system", subtype: "init", session_id: "sess-fake", model: "fake-model" });
say("CARBON_PLAN: alterar app.txt");
if (mode === "question") {
  say("CARBON_QUESTION: usar a fila A ou a fila B?");
  out({ type: "result", subtype: "success", is_error: false, result: "pergunta", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
} else if (mode === "edit") {
  writeFileSync("app.txt", "linha 1 alterada depois da resposta\\n");
  finish();
} else {
  await ask("req-1");
  if (mode === "ask2") await ask("req-2");
  finish();
}
`;

type Modules = {
  db: typeof import("@/server/db");
  tasks: typeof import("@/server/repo/tasks");
  projects: typeof import("@/server/repo/projects");
  users: typeof import("@/server/repo/users");
  settings: typeof import("@/server/repo/settings");
  rules: typeof import("@/server/permissions/rules");
  auth: typeof import("@/server/auth/worker-auth");
  runner: typeof import("@/server/runner/runner");
  claim: typeof import("@/app/api/worker/claim/route");
  heartbeat: typeof import("@/app/api/worker/tasks/[id]/heartbeat/route");
  events: typeof import("@/app/api/worker/tasks/[id]/events/route");
  bundle: typeof import("@/app/api/worker/tasks/[id]/bundle/route");
  result: typeof import("@/app/api/worker/tasks/[id]/result/route");
  permissions: typeof import("@/app/api/worker/tasks/[id]/permissions/route");
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
    rules: await import("@/server/permissions/rules"),
    auth: await import("@/server/auth/worker-auth"),
    runner: await import("@/server/runner/runner"),
    claim: await import("@/app/api/worker/claim/route"),
    heartbeat: await import("@/app/api/worker/tasks/[id]/heartbeat/route"),
    events: await import("@/app/api/worker/tasks/[id]/events/route"),
    bundle: await import("@/app/api/worker/tasks/[id]/bundle/route"),
    result: await import("@/app/api/worker/tasks/[id]/result/route"),
    permissions: await import("@/app/api/worker/tasks/[id]/permissions/route"),
  };
  ownerId = m.users.createUser({ email: "a@b.c", name: "Ana", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false }).id;
  agentScript = path.join(sandbox, "fake-agent.mjs");
  writeFileSync(agentScript, FAKE_AGENT);
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
beforeEach(() => {
  m.db.getDb().exec("DELETE FROM tasks");
  m.settings.saveSettings({
    autoPush: false,
    approvalPolicy: "ask",
    permissionTimeoutMinutes: TIMEOUT_MINUTES,
    workers: { leaseMs: LEASE_MS, pollMs: 25_000, requeueOnLeaseLoss: false, maxBundleMb: 200 },
  });
});

// ---------------------------------------------------------------- in-process panel

const TASK_ROUTE = /^\/api\/worker\/tasks\/([^/]+)\/(heartbeat|events|bundle|result|permissions)$/;

function panelFetch(calls: string[]): FetchLike {
  return async (url, init = {}) => {
    const request = new Request(url, init);
    const { pathname } = new URL(url);
    calls.push(`${request.method} ${pathname}`);
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
      case "permissions":
        return m.permissions.GET(request, ctx);
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

const unique = (name: string) => `${name}-${(counter += 1)}`;

function harness(): Harness {
  const calls: string[] = [];
  const { token } = m.auth.createWorker(unique("maquina"), "pool", ownerId);
  const client = createWorkerClient({ panelUrl: "http://panel.test", token, fetchImpl: panelFetch(calls) });
  return { client, calls, workDir: path.join(sandbox, unique("work")) };
}

function repo(name: string): string {
  const dir = path.join(sandbox, unique(name));
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "app.txt"), "linha 1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function poolTask(repoPath: string) {
  const project = m.projects.createProject({ name: path.basename(repoPath), repoPath, baseBranch: "main" });
  return m.tasks.createTask({
    projectId: project.id, key: "CAR-22", title: "Publicar", description: "rodar o deploy", source: "manual", sourceRef: null,
    requesterId: ownerId, requesterName: "Ana", persona: "engineering", executor: "claude", model: "auto", effort: "auto",
    priority: "medium", repo: "r", modelLabel: "x", runtime: "pool",
  });
}

const ticketOf = (taskId: string) => m.tasks.findTask(taskId)?.snapshot as Ticket;
const rawSnapshot = (taskId: string) =>
  JSON.parse((m.db.getDb().prepare("SELECT snapshot FROM tasks WHERE id = ?").get(taskId) as { snapshot: string }).snapshot) as Record<string, unknown>;
const leaseOf = (taskId: string) =>
  (m.db.getDb().prepare("SELECT lease_worker FROM tasks WHERE id = ?").get(taskId) as { lease_worker: string | null }).lease_worker;
const hasLog = (taskId: string, text: string) => (ticketOf(taskId)?.logs ?? []).some((l) => l.text.includes(text));
const promptOf = (taskId: string, requestId: string) => (ticketOf(taskId)?.permissions ?? []).find((p) => p.id === requestId);

async function claimOne(h: Harness): Promise<ClaimedTask> {
  const claimed = await h.client.claim(["claude"]);
  if (!claimed) throw new Error("nada para fazer claim");
  return claimed;
}

function run(h: Harness, claimed: ClaimedTask, mode: string, promptFile = path.join(sandbox, unique("prompt"))): Promise<RunOutcome> {
  return runClaimedTask(claimed, {
    client: h.client,
    workDir: h.workDir,
    executorOverride: (command) => ({ ...command, bin: process.execPath, args: [agentScript, mode, promptFile] }),
  });
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condição não atingida a tempo");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const pendingPrompt = (taskId: string, requestId: string) => () => promptOf(taskId, requestId)?.status === "pending";

// ---------------------------------------------------------------- RMT-01

describe("remote permissions (RMT-01)", () => {
  it("prompt reaches the panel as pending (durably), a human allows it and the agent continues", async () => {
    const h = harness();
    const dir = repo("allow");
    const task = poolTask(dir);
    const claimed = await claimOne(h);
    const outcome = run(h, claimed, "ask");

    await until(pendingPrompt(task.id, "req-1"));
    expect(ticketOf(task.id).status).toBe("waiting");
    // Stored in the snapshot itself: answering needs no in-memory state (survives a panel restart).
    expect(rawSnapshot(task.id).remotePermissions).toMatchObject({ pending: [{ requestId: "req-1", tool: "Bash", pattern: "make deploy" }] });

    expect(m.runner.answerPermission(task.id, "req-1", "allow", "Ana")).toEqual({ ok: true });
    expect(await outcome).toBe("done");

    expect(promptOf(task.id, "req-1")).toMatchObject({ status: "allowed", decidedBy: "Ana" });
    expect(hasLog(task.id, "Ana permitiu a ação")).toBe(true);
    expect(git(dir, "show", `${claimed.code.branch}:app.txt`)).toContain("deploy req-1 (make deploy)");
    expect(ticketOf(task.id).status).toBe("done");
    expect(m.runner.answerPermission(task.id, "req-1", "allow", "Ana")).toMatchObject({ ok: false });
  });

  it("deny: the agent gets the panel's message and goes on without the action", async () => {
    const h = harness();
    const dir = repo("deny");
    const task = poolTask(dir);
    const claimed = await claimOne(h);
    const outcome = run(h, claimed, "ask");

    await until(pendingPrompt(task.id, "req-1"));
    expect(m.runner.answerPermission(task.id, "req-1", "deny", "Ana")).toEqual({ ok: true });
    expect(await outcome).toBe("done");

    expect(promptOf(task.id, "req-1")).toMatchObject({ status: "denied", decidedBy: "Ana" });
    expect(hasLog(task.id, "negado req-1: Ana negou esta ação no painel")).toBe(true);
    expect(hasLog(task.id, "nada a entregar")).toBe(true);
    expect(git(dir, "branch", "--list", claimed.code.branch)).toBe("");
  });

  it("timeout: past permissionTimeoutMinutes the panel denies it and marks the prompt expired", async () => {
    const h = harness();
    const task = poolTask(repo("timeout"));
    const claimed = await claimOne(h);
    const outcome = run(h, claimed, "ask");

    await until(pendingPrompt(task.id, "req-1"));
    // The clock is persisted with the prompt: age it past the timeout as if minutes had passed.
    m.db.getDb().prepare("UPDATE tasks SET snapshot = json_set(snapshot, '$.remotePermissions.pending[0].askedAt', 0) WHERE id = ?").run(task.id);
    expect(await outcome).toBe("done");

    expect(promptOf(task.id, "req-1")).toMatchObject({ status: "expired", decidedBy: null });
    expect(hasLog(task.id, `permissão expirou após ${TIMEOUT_MINUTES} min sem resposta`)).toBe(true);
    expect(hasLog(task.id, `negado req-1: Sem resposta em ${TIMEOUT_MINUTES} min`)).toBe(true);
    expect(m.runner.answerPermission(task.id, "req-1", "allow", "Ana")).toMatchObject({ ok: false });
  });

  it("allow all for the task: later prompts are allowed by the worker without asking again", async () => {
    const h = harness();
    const dir = repo("allow-task");
    const task = poolTask(dir);
    const claimed = await claimOne(h);
    const outcome = run(h, claimed, "ask2");

    await until(pendingPrompt(task.id, "req-1"));
    expect(m.runner.answerPermission(task.id, "req-1", "allow_task", "Ana")).toEqual({ ok: true });
    expect(await outcome).toBe("done");

    expect(promptOf(task.id, "req-2")).toBeUndefined();
    expect(hasLog(task.id, "liberou tudo no resto desta tarefa")).toBe(true);
    expect(git(dir, "show", `${claimed.code.branch}:app.txt`)).toContain("deploy req-2");
  });

  it("always allow in this repo: rule saved and the worker reuses it for the identical next prompt", async () => {
    const h = harness();
    const dir = repo("allow-always");
    const task = poolTask(dir);
    const claimed = await claimOne(h);
    const outcome = run(h, claimed, "ask2");

    await until(pendingPrompt(task.id, "req-1"));
    expect(m.runner.answerPermission(task.id, "req-1", "allow_always", "Ana")).toEqual({ ok: true });
    expect(await outcome).toBe("done");

    expect(m.rules.listRules(dir)).toEqual([expect.objectContaining({ tool: "Bash", pattern: "make deploy" })]);
    expect(promptOf(task.id, "req-2")).toBeUndefined();
    expect(git(dir, "show", `${claimed.code.branch}:app.txt`)).toContain("deploy req-2");
  });
});

// ---------------------------------------------------------------- RMT-02

describe("remote questions (RMT-02)", () => {
  it("question → waiting without failure → answer requeues on the same runtime → next claim carries the decisions → done", async () => {
    const h = harness();
    const dir = repo("pergunta");
    const task = poolTask(dir);
    const first = await claimOne(h);

    expect(await run(h, first, "question")).toBe("waiting");

    const parked = ticketOf(task.id);
    expect(parked.status).toBe("waiting");
    expect(parked.questions).toEqual([expect.objectContaining({ text: "usar a fila A ou a fila B?", answer: null })]);
    expect(leaseOf(task.id)).toBeNull();
    expect(hasLog(task.id, "aguardando sua resposta")).toBe(true);
    expect(await h.client.claim(["claude"])).toBeNull();

    const questionId = parked.questions?.[0]?.id ?? "";
    expect(m.runner.answerTaskQuestion(task.id, questionId, "fila B", "Ana")).toEqual({ ok: true });
    const queued = m.tasks.findTask(task.id);
    expect(queued).toMatchObject({ status: "queued", runtime: "pool" });
    expect(queued?.snapshot.resume).toBe(true);

    const second = await claimOne(h);
    expect(second.taskId).toBe(task.id);
    expect(second.resume?.decisions).toEqual([expect.stringContaining("Answer from Ana: fila B")]);
    expect(second.prompt).toContain("<human-decisions>");
    expect(second.prompt).toContain("fila B");

    const promptFile = path.join(sandbox, unique("prompt"));
    expect(await run(h, second, "edit", promptFile)).toBe("done");
    expect(readFileSync(promptFile, "utf8")).toContain("fila B");
    expect(ticketOf(task.id).status).toBe("done");
    expect(git(dir, "show", `${second.code.branch}:app.txt`)).toBe("linha 1 alterada depois da resposta");
    // The resumed run keeps the earlier history (question and answer) on the ticket.
    expect(hasLog(task.id, "Ana respondeu: fila B")).toBe(true);
  });

  it("a remote task still leased cannot have its question answered (it is running on a worker)", async () => {
    const h = harness();
    const task = poolTask(repo("leased"));
    const claimed = await claimOne(h);
    const outcome = run(h, claimed, "ask");
    await until(pendingPrompt(task.id, "req-1"));

    expect(m.runner.answerTaskQuestion(task.id, "x", "y", "Ana")).toEqual({ ok: false, error: "esta tarefa já está executando" });

    m.runner.answerPermission(task.id, "req-1", "deny", "Ana");
    expect(await outcome).toBe("done");
  });
});
