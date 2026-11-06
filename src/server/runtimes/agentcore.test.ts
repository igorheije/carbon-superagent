import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import type { ClaimedTask } from "@/shared/worker-protocol";

// SDK replaced by a fake `send`: no AWS call, no credentials (decision U5).
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-agentcore-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

const ARN = "arn:aws:bedrock-agentcore:sa-east-1:123456789012:runtime/carbon_worker-AbC123";
const PANEL = "https://painel.exemplo.dev";

type Modules = {
  db: typeof import("../db");
  tasks: typeof import("../repo/tasks");
  projects: typeof import("../repo/projects");
  users: typeof import("../repo/users");
  settings: typeof import("../repo/settings");
  auth: typeof import("../auth/worker-auth");
  dispatcher: typeof import("./agentcore");
  store: typeof import("./agentcore-store");
  session: typeof import("./session");
  claim: typeof import("@/app/api/worker/agentcore/claim/route");
  heartbeat: typeof import("@/app/api/worker/tasks/[id]/heartbeat/route");
  events: typeof import("@/app/api/worker/tasks/[id]/events/route");
};
let m: Modules;
let ownerId = "";
let repoPath = "";

beforeAll(async () => {
  m = {
    db: await import("../db"),
    tasks: await import("../repo/tasks"),
    projects: await import("../repo/projects"),
    users: await import("../repo/users"),
    settings: await import("../repo/settings"),
    auth: await import("../auth/worker-auth"),
    dispatcher: await import("./agentcore"),
    store: await import("./agentcore-store"),
    session: await import("./session"),
    claim: await import("@/app/api/worker/agentcore/claim/route"),
    heartbeat: await import("@/app/api/worker/tasks/[id]/heartbeat/route"),
    events: await import("@/app/api/worker/tasks/[id]/events/route"),
  };
  ownerId = m.users.createUser({ email: "a@b.c", name: "Ana", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false }).id;
  repoPath = path.join(sandbox, "repo");
  mkdirSync(repoPath, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd: repoPath, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repoPath, "README.md"), "# r\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  m.projects.createProject({ name: "repo", repoPath, baseBranch: "main" });
  m.settings.saveSettings({
    panelPublicUrl: PANEL,
    agentcore: { enabled: true, region: "sa-east-1", runtimeArn: ARN, qualifier: "DEFAULT", maxConcurrent: 2 },
  });
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
beforeEach(() => {
  m.db.getDb().exec("DELETE FROM tasks; DELETE FROM task_tokens;");
});

function agentcoreTask(key: string) {
  const project = m.projects.findProjectByRepo(repoPath);
  return m.tasks.createTask({
    projectId: project?.id ?? "p", key, title: "Corrigir rodapé", description: "ajustar texto", source: "manual", sourceRef: null,
    requesterId: ownerId, requesterName: "Ana", persona: "engineering", executor: "claude", model: "auto", effort: "auto",
    priority: "medium", repo: "r", modelLabel: "x", runtime: "agentcore",
  });
}

interface Sent {
  readonly kind: "invoke" | "stop";
  readonly input: Record<string, unknown>;
  readonly region: string;
}

function fakeSdk(failInvokes = 0) {
  const sent: Sent[] = [];
  let failures = failInvokes;
  const send: import("./agentcore").AgentCoreSend = async (command, region) => {
    const kind = command instanceof (await import("@aws-sdk/client-bedrock-agentcore")).InvokeAgentRuntimeCommand ? "invoke" : "stop";
    sent.push({ kind, input: command.input as unknown as Record<string, unknown>, region });
    if (kind === "invoke" && failures > 0) {
      failures -= 1;
      throw Object.assign(new Error("Rate exceeded for token ctk_abcDEF123 key AKIAABCDEFGHIJKLMNOP"), { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } });
    }
    return { statusCode: 200, response: { destroy: () => undefined } };
  };
  return { sent, send };
}

function newDispatcher(send: import("./agentcore").AgentCoreSend, sleeps: number[] = []) {
  return m.dispatcher.createAgentCoreDispatcher({
    send,
    hasCredentials: () => true,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

const payloadOf = (s: Sent) => JSON.parse(new TextDecoder().decode(s.input.payload as Uint8Array)) as { taskId: string; panelUrl: string; taskToken: string };

function post(url: string, auth: string | null, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request(`http://127.0.0.1${url}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const claimReq = (token: string | null, taskId: string) => post("/api/worker/agentcore/claim", token, { taskId });

describe("session id", () => {
  it("is deterministic, ≥ 33 chars and safe for AgentCore", () => {
    const a = m.session.agentcoreSessionId("3f2a9c1e-1111-4222-8333-444455556666");
    expect(a).toBe(m.session.agentcoreSessionId("3f2a9c1e-1111-4222-8333-444455556666"));
    expect(a.length).toBeGreaterThanOrEqual(33);
    expect(m.session.agentcoreSessionId("x").length).toBe(33);
    expect(m.session.agentcoreSessionId("a/b c")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("dispatcher", () => {
  it("invokes with ARN, qualifier, session ≥ 33 chars and a one-time token payload; marks the task running", async () => {
    const task = agentcoreTask("AC-1");
    const sdk = fakeSdk();
    await newDispatcher(sdk.send).tick();
    expect(sdk.sent).toHaveLength(1);
    const [invoke] = sdk.sent;
    expect(invoke?.kind).toBe("invoke");
    expect(invoke?.region).toBe("sa-east-1");
    expect(invoke?.input).toMatchObject({ agentRuntimeArn: ARN, qualifier: "DEFAULT", runtimeSessionId: m.session.agentcoreSessionId(task.id) });
    expect(String(invoke?.input.runtimeSessionId).length).toBeGreaterThanOrEqual(33);
    const payload = payloadOf(invoke as Sent);
    expect(payload).toMatchObject({ taskId: task.id, panelUrl: PANEL });
    expect(payload.taskToken).toMatch(/^ctk_/);
    const stored = m.tasks.findTask(task.id);
    expect(stored?.status).toBe("running");
    expect(stored?.snapshot.logs.at(-1)?.text).toContain(m.session.agentcoreSessionId(task.id));
    // Token stored only as a hash.
    expect(JSON.stringify(m.db.getDb().prepare("SELECT * FROM task_tokens").all())).not.toContain(payload.taskToken);
  });

  it("respects maxConcurrent across ticks", async () => {
    for (const key of ["AC-1", "AC-2", "AC-3"]) agentcoreTask(key);
    const sdk = fakeSdk();
    const dispatcher = newDispatcher(sdk.send);
    await dispatcher.tick();
    await dispatcher.tick();
    expect(sdk.sent.filter((s) => s.kind === "invoke")).toHaveLength(2);
    expect(m.store.countActiveSessions()).toBe(2);
    expect(m.tasks.listTasks(null).filter((t) => t.status === "queued")).toHaveLength(1);
  });

  it("counts a session waiting on a permission (live lease) toward maxConcurrent, but not one parked on a question", async () => {
    const [a, b] = ["AC-1", "AC-2"].map((key) => agentcoreTask(key));
    agentcoreTask("AC-3");
    const sdk = fakeSdk();
    const dispatcher = newDispatcher(sdk.send);
    await dispatcher.tick();
    const db = m.db.getDb();
    // A: blocked on a permission prompt — container alive under its lease.
    db.prepare("UPDATE tasks SET status = 'waiting', lease_worker = 'agentcore:x', lease_expires_at = ? WHERE id = ?").run(Date.now() + 60_000, a?.id ?? "");
    // B: still running.
    await dispatcher.tick();
    expect(m.store.countActiveSessions()).toBe(2);
    expect(sdk.sent.filter((s) => s.kind === "invoke")).toHaveLength(2);
    // A parks on a question: result reported, lease released → the session slot frees up.
    db.prepare("UPDATE tasks SET lease_worker = NULL, lease_expires_at = NULL WHERE id = ?").run(a?.id ?? "");
    expect(m.store.countActiveSessions()).toBe(1);
    await dispatcher.tick();
    expect(sdk.sent.filter((s) => s.kind === "invoke")).toHaveLength(3);
    expect(b?.id).toBeTruthy();
  });

  it("does nothing when AgentCore is unavailable (no credentials)", async () => {
    agentcoreTask("AC-1");
    const sdk = fakeSdk();
    await m.dispatcher.createAgentCoreDispatcher({ send: sdk.send, hasCredentials: () => false }).tick();
    expect(sdk.sent).toHaveLength(0);
  });

  it("retries Invoke 3x with backoff, then fails with a redacted SDK summary", async () => {
    const task = agentcoreTask("AC-1");
    const sdk = fakeSdk(10);
    const sleeps: number[] = [];
    await newDispatcher(sdk.send, sleeps).tick();
    expect(sdk.sent.filter((s) => s.kind === "invoke")).toHaveLength(1 + m.dispatcher.INVOKE_RETRIES);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    const failed = m.tasks.findTask(task.id);
    expect(failed?.status).toBe("failed");
    const last = failed?.snapshot.logs.at(-1)?.text ?? "";
    expect(last).toContain("ThrottlingException (HTTP 429)");
    expect(last).not.toMatch(/ctk_abc|AKIAABCDEF/);
    expect(m.db.getDb().prepare("SELECT COUNT(*) AS n FROM task_tokens WHERE task_id = ?").get(task.id)).toEqual({ n: 0 });
  });

  it("succeeds when a retry works", async () => {
    const task = agentcoreTask("AC-1");
    const sdk = fakeSdk(2);
    await newDispatcher(sdk.send).tick();
    expect(sdk.sent).toHaveLength(3);
    expect(m.tasks.findTask(task.id)?.status).toBe("running");
  });

  it.each(["done", "failed"] as const)("calls StopRuntimeSession when the task ends (%s) and drops its tokens", async (status) => {
    const task = agentcoreTask("AC-1");
    const sdk = fakeSdk();
    const dispatcher = newDispatcher(sdk.send);
    await dispatcher.tick();
    expect(dispatcher.tracked()).toEqual([task.id]);
    const current = m.tasks.findTask(task.id) as NonNullable<ReturnType<typeof m.tasks.findTask>>;
    m.tasks.saveSnapshot(task.id, { ...current.snapshot, status } as Ticket);
    await dispatcher.tick();
    const stop = sdk.sent.find((s) => s.kind === "stop");
    expect(stop?.input).toMatchObject({ agentRuntimeArn: ARN, qualifier: "DEFAULT", runtimeSessionId: m.session.agentcoreSessionId(task.id) });
    expect(dispatcher.tracked()).toEqual([]);
    expect(m.db.getDb().prepare("SELECT COUNT(*) AS n FROM task_tokens WHERE task_id = ?").get(task.id)).toEqual({ n: 0 });
    await dispatcher.tick();
    expect(sdk.sent.filter((s) => s.kind === "stop")).toHaveLength(1);
  });

  it("stops a canceled task's session (canceled tasks end as failed) after a panel restart", async () => {
    const task = agentcoreTask("AC-1");
    await newDispatcher(fakeSdk().send).tick();
    // New dispatcher = panel restarted: it picks the running task up from the DB.
    const sdk = fakeSdk();
    const restarted = newDispatcher(sdk.send);
    expect(restarted.tracked()).toEqual([task.id]);
    const current = m.tasks.findTask(task.id) as NonNullable<ReturnType<typeof m.tasks.findTask>>;
    m.tasks.saveSnapshot(task.id, { ...current.snapshot, status: "failed" } as Ticket);
    await restarted.tick();
    expect(sdk.sent.map((s) => s.kind)).toEqual(["stop"]);
  });
});

describe("recovery", { timeout: 30_000 }, () => {
  it("fails dispatched tasks that no container claimed within 10 minutes", async () => {
    const task = agentcoreTask("AC-1");
    await newDispatcher(fakeSdk().send).tick();
    expect(m.store.failLostSessions(Date.now() + 60_000)).toEqual([]);
    expect(m.store.failLostSessions(Date.now() + m.store.CLAIM_DEADLINE_MS + 1_000)).toEqual([task.id]);
    const failed = m.tasks.findTask(task.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.snapshot.logs.at(-1)?.text).toContain(m.store.SESSION_LOST);
  });

  it("leaves claimed tasks alone (their lease is swept instead)", async () => {
    const task = agentcoreTask("AC-1");
    const sdk = fakeSdk();
    await newDispatcher(sdk.send).tick();
    const response = await m.claim.POST(claimReq(payloadOf(sdk.sent[0] as Sent).taskToken, task.id));
    expect(response.status).toBe(200);
    expect(m.store.failLostSessions(Date.now() + m.store.CLAIM_DEADLINE_MS + 1_000)).toEqual([]);
  });
});

// prepareClaim indexes the repo (git + knowledge): slow on a loaded machine.
describe("claim + task-token auth", { timeout: 30_000 }, () => {
  async function dispatched(key: string) {
    const task = agentcoreTask(key);
    const sdk = fakeSdk();
    await newDispatcher(sdk.send).tick();
    const invoke = sdk.sent.find((s) => payloadOf(s).taskId === task.id) as Sent;
    return { task, token: payloadOf(invoke).taskToken };
  }

  it("valid token → ClaimedTask with the AgentCore lease", async () => {
    const { task, token } = await dispatched("AC-1");
    const response = await m.claim.POST(claimReq(token, task.id));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: ClaimedTask };
    expect(body.data.taskId).toBe(task.id);
    const row = m.db.getDb().prepare("SELECT lease_worker FROM tasks WHERE id = ?").get(task.id) as { lease_worker: string };
    expect(row.lease_worker).toBe(m.session.agentcoreWorkerId(task.id));
  });

  it("reused token → 401", async () => {
    const { task, token } = await dispatched("AC-1");
    expect((await m.claim.POST(claimReq(token, task.id))).status).toBe(200);
    expect((await m.claim.POST(claimReq(token, task.id))).status).toBe(401);
  });

  it("token of another task → 401, and the victim stays unclaimed", async () => {
    const a = await dispatched("AC-1");
    const b = await dispatched("AC-2");
    expect((await m.claim.POST(claimReq(a.token, b.task.id))).status).toBe(401);
    expect((await m.claim.POST(claimReq(null, b.task.id))).status).toBe(401);
    const row = m.db.getDb().prepare("SELECT lease_worker FROM tasks WHERE id = ?").get(b.task.id) as { lease_worker: string | null };
    expect(row.lease_worker).toBeNull();
  });

  it("after claim the token authenticates only its own task's routes, until the task ends", async () => {
    const a = await dispatched("AC-1");
    const b = await dispatched("AC-2");
    expect((await m.claim.POST(claimReq(a.token, a.task.id))).status).toBe(200);
    expect((await m.claim.POST(claimReq(b.token, b.task.id))).status).toBe(200);

    const beat = (token: string, id: string) => m.heartbeat.POST(post(`/api/worker/tasks/${id}/heartbeat`, token, {}), params(id));
    expect((await beat(a.token, a.task.id)).status).toBe(200);
    const events = await m.events.POST(post(`/api/worker/tasks/${a.task.id}/events`, a.token, { seq: 1, events: [{ type: "text", text: "oi" }] }), params(a.task.id));
    expect(events.status).toBe(200);
    // Foreign task, even if the route param were forged to match: the URL path is the scope.
    expect((await beat(a.token, b.task.id)).status).toBe(401);
    expect((await m.heartbeat.POST(post(`/api/worker/tasks/${b.task.id}/heartbeat`, a.token, {}), params(a.task.id))).status).toBe(401);
    // Not a task-scoped route.
    expect(() => m.auth.requireWorker(post("/api/worker/hello", a.token, {}))).toThrow();

    const current = m.tasks.findTask(a.task.id) as NonNullable<ReturnType<typeof m.tasks.findTask>>;
    m.tasks.saveSnapshot(a.task.id, { ...current.snapshot, status: "done" } as Ticket);
    expect((await beat(a.token, a.task.id)).status).toBe(401);
  });

  it("an unclaimed (unburned) token cannot be used on task routes", async () => {
    const { task, token } = await dispatched("AC-1");
    const response = await m.heartbeat.POST(post(`/api/worker/tasks/${task.id}/heartbeat`, token, {}), params(task.id));
    expect(response.status).toBe(401);
  });

  it("expired token → 401 on claim", async () => {
    const task = agentcoreTask("AC-1");
    const token = m.auth.issueTaskToken(task.id, 1_000, Date.now() - 10_000);
    expect((await m.claim.POST(claimReq(token, task.id))).status).toBe(401);
  });
});
