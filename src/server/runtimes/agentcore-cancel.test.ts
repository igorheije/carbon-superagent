import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ticket } from "@/lib/domain/types";

// Cancel of an AgentCore task the container has not claimed yet, the exported session stop and
// the dispatcher keeping a session that waits for a permission answer. No AWS: `send` is faked and
// the panel settings have no runtime ARN unless a test injects one.
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-agentcore-cancel-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

vi.mock("@/server/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/http")>()),
  requireUser: async () => ({ id: "u1", name: "Ana" }),
}));

const ARN = "arn:aws:bedrock-agentcore:sa-east-1:123456789012:runtime/carbon_worker-AbC123";

type Modules = {
  db: typeof import("../db");
  tasks: typeof import("../repo/tasks");
  projects: typeof import("../repo/projects");
  users: typeof import("../repo/users");
  settings: typeof import("../repo/settings");
  auth: typeof import("../auth/worker-auth");
  agentcore: typeof import("./agentcore");
  store: typeof import("./agentcore-store");
  session: typeof import("./session");
  scheduler: typeof import("../runner/scheduler");
  route: typeof import("@/app/api/tasks/[id]/route");
};
let m: Modules;
let ownerId = "";
let projectId = "";

beforeAll(async () => {
  m = {
    db: await import("../db"),
    tasks: await import("../repo/tasks"),
    projects: await import("../repo/projects"),
    users: await import("../repo/users"),
    settings: await import("../repo/settings"),
    auth: await import("../auth/worker-auth"),
    agentcore: await import("./agentcore"),
    store: await import("./agentcore-store"),
    session: await import("./session"),
    scheduler: await import("../runner/scheduler"),
    route: await import("@/app/api/tasks/[id]/route"),
  };
  ownerId = m.users.createUser({ email: "a@b.c", name: "Ana", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false }).id;
  const repoPath = path.join(sandbox, "repo");
  mkdirSync(repoPath, { recursive: true });
  projectId = m.projects.createProject({ name: "repo", repoPath, baseBranch: "main" }).id;
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
beforeEach(() => {
  m.db.getDb().exec("DELETE FROM tasks; DELETE FROM task_tokens;");
});

function agentcoreTask(key: string) {
  return m.tasks.createTask({
    projectId, key, title: "Corrigir rodapé", description: "ajustar texto", source: "manual", sourceRef: null,
    requesterId: ownerId, requesterName: "Ana", persona: "engineering", executor: "claude", model: "auto", effort: "auto",
    priority: "medium", repo: "r", modelLabel: "x", runtime: "agentcore",
  });
}

const withArn = () => {
  const s = m.settings.getSettings();
  return { ...s, agentcore: { ...s.agentcore, enabled: true, runtimeArn: ARN, qualifier: "DEFAULT", maxConcurrent: 2 }, panelPublicUrl: "https://painel.exemplo.dev" };
};

function fakeSend() {
  const sent: { kind: "invoke" | "stop"; input: Record<string, unknown> }[] = [];
  const send: import("./agentcore").AgentCoreSend = async (command) => {
    const { InvokeAgentRuntimeCommand } = await import("@aws-sdk/client-bedrock-agentcore");
    sent.push({ kind: command instanceof InvokeAgentRuntimeCommand ? "invoke" : "stop", input: command.input as unknown as Record<string, unknown> });
    return { response: { destroy: () => undefined } };
  };
  return { sent, send };
}

const cancel = (id: string) =>
  m.route.POST(new Request(`http://127.0.0.1/api/tasks/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }) }), {
    params: Promise.resolve({ id }),
  });

describe("cancel of an AgentCore task dispatched but not claimed", () => {
  it("fails it right away, logs who canceled and revokes the task token (no more 409)", async () => {
    const task = agentcoreTask("AC-9");
    expect(m.store.markDispatched(task.id, m.session.agentcoreSessionId(task.id), Date.now())).toBe(true);
    const token = m.auth.issueTaskToken(task.id, 60_000);

    const res = await cancel(task.id);
    expect(res.status).toBe(200);

    const after = m.tasks.findTask(task.id);
    expect(after?.status).toBe("failed");
    expect((after?.snapshot as Ticket).logs.at(-1)?.text).toBe("cancelado por você");
    // The container can no longer claim it.
    expect(m.auth.consumeTaskToken(token, task.id)).toBe(false);
    expect(m.scheduler.claimSpecific(task.id, "agentcore:x", 10_000)).toBeNull();
  });

  it("a leased AgentCore task still goes through requestCancel (worker stops it on heartbeat)", async () => {
    const task = agentcoreTask("AC-10");
    m.store.markDispatched(task.id, m.session.agentcoreSessionId(task.id), Date.now());
    expect(m.scheduler.claimSpecific(task.id, "agentcore:x", 10_000)).not.toBeNull();

    expect((await cancel(task.id)).status).toBe(200);
    expect(m.tasks.findTask(task.id)?.status).toBe("running");
    expect(m.scheduler.renew(task.id, "agentcore:x", 10_000)).toEqual({ cancel: true });
  });

  it("a queued (not dispatched) remote task still answers 409", async () => {
    const task = agentcoreTask("AC-11");
    expect((await cancel(task.id)).status).toBe(409);
  });
});

describe("stopAgentCoreSession", () => {
  it("sends StopRuntimeSession for the task's session and revokes its tokens", async () => {
    const task = agentcoreTask("AC-12");
    const token = m.auth.issueTaskToken(task.id, 60_000);
    const sdk = fakeSend();

    await m.agentcore.stopAgentCoreSession(task.id, { send: sdk.send, settings: withArn() });

    expect(sdk.sent).toEqual([{ kind: "stop", input: expect.objectContaining({ agentRuntimeArn: ARN, runtimeSessionId: m.session.agentcoreSessionId(task.id) }) }]);
    expect(m.auth.consumeTaskToken(token, task.id)).toBe(false);
  });

  it("never throws when the SDK fails", async () => {
    const task = agentcoreTask("AC-13");
    const send: import("./agentcore").AgentCoreSend = async () => {
      throw new Error("sem credenciais");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(m.agentcore.stopAgentCoreSession(task.id, { send, settings: withArn() })).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("dispatcher and permission waits (RMT-01)", () => {
  it("keeps the session of a task waiting for a permission under its lease; stops it once the lease is gone", async () => {
    const task = agentcoreTask("AC-14");
    const sdk = fakeSend();
    const dispatcher = m.agentcore.createAgentCoreDispatcher({ send: sdk.send, settings: withArn, hasCredentials: () => true, sleep: async () => undefined });
    await dispatcher.tick();
    expect(sdk.sent.map((s) => s.kind)).toEqual(["invoke"]);
    expect(m.scheduler.claimSpecific(task.id, "agentcore:x", 60_000)).not.toBeNull();

    m.db.getDb().prepare("UPDATE tasks SET status = 'waiting' WHERE id = ?").run(task.id);
    await dispatcher.tick();
    expect(sdk.sent.map((s) => s.kind)).toEqual(["invoke"]);

    // The question path: result reported, lease released, task parked in waiting → session stopped.
    m.scheduler.releaseLease(task.id, "agentcore:x");
    await dispatcher.tick();
    expect(sdk.sent.map((s) => s.kind)).toEqual(["invoke", "stop"]);
  });
});
