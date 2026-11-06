import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AGENTCORE_CLAIM_PATH, type ClaimedTask } from "../shared/worker-protocol";
import { claimAgentCoreTask, createAgentCoreServer, readEntryConfig, type AgentCoreDeps, type AgentCoreServer, type Invocation } from "./agentcore-entry";
import { WorkerClientError, type WorkerClient } from "./client";
import type { RunOutcome, RunTaskDeps } from "./run-task";

const TOKEN = "ctk_abcdefghijklmnopqrstuvwxyz";

function claimed(taskId: string): ClaimedTask {
  return {
    taskId,
    key: `CAR-${taskId}`,
    leaseMs: 60_000,
    executor: "claude",
    model: { model: null, effort: null, label: "auto", reason: "teste" },
    prompt: "p",
    resume: null,
    code: { transport: "bundle", baseRef: "main", branch: `agent/${taskId}`, bundleUrl: "/x" },
    limits: { maxRunMinutes: 10 },
    permissionRules: [],
    settings: { permissionProfile: "guarded", isolateClaudeConfig: false, approvalPolicy: "ask" },
    files: [],
  };
}

const invocation = (taskId: string, panelUrl = "https://painel.exemplo.test"): Invocation => ({ taskId, panelUrl, taskToken: TOKEN });

/** A runTask fake that blocks until `release()` (or the cancel signal) and records its calls. */
function controllableRun() {
  const calls: { task: ClaimedTask; deps: RunTaskDeps }[] = [];
  let release: (outcome: RunOutcome) => void = () => undefined;
  const runTask = (task: ClaimedTask, deps: RunTaskDeps) =>
    new Promise<RunOutcome>((resolve) => {
      calls.push({ task, deps });
      release = resolve;
      deps.signal?.addEventListener("abort", () => resolve("canceled"), { once: true });
    });
  return { calls, runTask, release: (outcome: RunOutcome = "done") => release(outcome) };
}

const fakeClient = {} as WorkerClient;
const running: AgentCoreServer[] = [];

async function start(overrides: Partial<AgentCoreDeps> = {}) {
  const app = createAgentCoreServer({
    workDir: "/tmp/carbon-agentcore-test",
    allowedPanelOrigin: "https://painel.exemplo.test",
    claim: async (inv) => claimed(inv.taskId),
    createClient: () => fakeClient,
    ...overrides,
  });
  running.push(app);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const invoke = (body: unknown) => fetch(`${base}/invocations`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const ping = async () => (await (await fetch(`${base}/ping`)).json()) as { status: string; time_of_last_update: number };
  return { app, base, invoke, ping };
}

afterEach(async () => {
  for (const app of running.splice(0)) await app.shutdown(0);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("agentcore entry: /invocations and /ping", () => {
  it("answers 202 in under 1 s and runs the claimed task in the background", async () => {
    const run = controllableRun();
    const { app, invoke } = await start({ runTask: run.runTask });

    const startedAt = performance.now();
    const res = await invoke(invocation("t1"));
    const elapsed = performance.now() - startedAt;

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, taskId: "t1" });
    expect(elapsed).toBeLessThan(1000);
    await tick();
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].task.taskId).toBe("t1");
    expect(run.calls[0].deps.client).toBe(fakeClient);
    expect(app.currentTaskId()).toBe("t1");
    run.release();
    await app.idle();
    expect(app.currentTaskId()).toBeNull();
  });

  it("reports HealthyBusy while the task runs and Healthy before and after", async () => {
    const run = controllableRun();
    const { app, invoke, ping } = await start({ runTask: run.runTask });

    const before = await ping();
    expect(before.status).toBe("Healthy");
    expect(Number.isInteger(before.time_of_last_update)).toBe(true);
    await invoke(invocation("t1"));
    expect((await ping()).status).toBe("HealthyBusy");
    run.release();
    await app.idle();
    expect((await ping()).status).toBe("Healthy");
  });

  it("refuses another task with 409 while busy", async () => {
    const run = controllableRun();
    const { app, invoke } = await start({ runTask: run.runTask });

    await invoke(invocation("t1"));
    const res = await invoke(invocation("t2"));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ accepted: false });
    await tick();
    expect(run.calls).toHaveLength(1);
    run.release();
    await app.idle();
  });

  it("is idempotent for the same taskId (202, no second run)", async () => {
    const run = controllableRun();
    const claims: string[] = [];
    const { app, invoke } = await start({
      runTask: run.runTask,
      claim: async (inv) => {
        claims.push(inv.taskId);
        return claimed(inv.taskId);
      },
    });

    expect((await invoke(invocation("t1"))).status).toBe(202);
    const again = await invoke(invocation("t1"));

    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ accepted: true, taskId: "t1" });
    await tick();
    expect(claims).toEqual(["t1"]);
    expect(run.calls).toHaveLength(1);
    run.release();
    await app.idle();
  });

  it("goes back to Healthy when the claim fails (no run)", async () => {
    const run = controllableRun();
    const logs: string[] = [];
    const { app, invoke, ping } = await start({
      runTask: run.runTask,
      log: (m) => logs.push(m),
      claim: async () => {
        throw new WorkerClientError("token já usado", 401, false);
      },
    });

    expect((await invoke(invocation("t1"))).status).toBe(202);
    await app.idle();

    expect(run.calls).toHaveLength(0);
    expect((await ping()).status).toBe("Healthy");
    expect(logs.join("\n")).toContain("token já usado");
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("validates the payload (400) and the HTTP surface (404/405)", async () => {
    const { base, invoke } = await start();

    expect((await invoke("{not json")).status).toBe(400);
    expect((await invoke({ taskId: "t1", panelUrl: "ftp://x", taskToken: TOKEN })).status).toBe(400);
    expect((await invoke({ taskId: "t1", panelUrl: "https://p.test", taskToken: "curto" })).status).toBe(400);
    expect((await invoke({ taskId: "", panelUrl: "https://p.test", taskToken: TOKEN })).status).toBe(400);
    expect((await fetch(`${base}/invocations`)).status).toBe(405);
    expect((await fetch(`${base}/ping`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/`)).status).toBe(404);
  });

  it("rejects bodies above the JSON limit with 413", async () => {
    const { invoke } = await start();
    const res = await invoke({ taskId: "t1", panelUrl: "https://p.test", taskToken: TOKEN, pad: "x".repeat(1024 * 1024 + 10) }).catch(() => null);
    // The server may reset the socket after answering; either way nothing is accepted.
    if (res) expect(res.status).toBe(413);
  });

  it("refuses invocations for another panel origin (CARBON_PANEL_URL is always pinned)", async () => {
    const run = controllableRun();
    const { app, invoke } = await start({ runTask: run.runTask, allowedPanelOrigin: "https://painel.exemplo.test" });

    expect((await invoke(invocation("t1", "https://outro.test"))).status).toBe(403);
    expect((await invoke(invocation("t1", "https://painel.exemplo.test/sub"))).status).toBe(202);
    run.release();
    await app.idle();
  });
});

describe("agentcore entry: graceful shutdown", () => {
  it("refuses new invocations and cancels the task after the grace period", async () => {
    const run = controllableRun();
    const { app, invoke } = await start({ runTask: run.runTask });
    await invoke(invocation("t1"));
    await tick();

    const stopping = app.shutdown(0);
    await stopping;

    expect(run.calls[0].deps.signal?.aborted).toBe(true);
    expect(app.currentTaskId()).toBeNull();
    running.splice(running.indexOf(app), 1);
  });

  it("lets the task finish when it ends within the grace period", async () => {
    const run = controllableRun();
    const { app, invoke } = await start({ runTask: run.runTask });
    await invoke(invocation("t1"));
    await tick();

    const stopping = app.shutdown(30);
    const late = await invoke(invocation("t2")).catch(() => null);
    if (late) expect(late.status).toBe(503);
    run.release("done");
    await stopping;

    expect(run.calls[0].deps.signal?.aborted).toBe(false);
    running.splice(running.indexOf(app), 1);
  });
});

describe("claimAgentCoreTask", () => {
  const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data, error: null }), { status, headers: { "content-type": "application/json" } });
  const fail = (status: number, error: string) => new Response(JSON.stringify({ success: false, data: null, error }), { status });
  const noSleep = async () => undefined;

  it("posts {taskId} with the task token as Bearer to the agentcore claim path", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const task = await claimAgentCoreTask(invocation("t1", "https://painel.exemplo.test/"), {
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return ok(claimed("t1"));
      },
    });

    expect(task.taskId).toBe("t1");
    expect(seen[0].url).toBe(`https://painel.exemplo.test${AGENTCORE_CLAIM_PATH}`);
    expect(seen[0].init?.method).toBe("POST");
    expect((seen[0].init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({ taskId: "t1" });
  });

  it("retries network errors and 5xx, then succeeds", async () => {
    let calls = 0;
    const task = await claimAgentCoreTask(invocation("t1"), {
      sleep: noSleep,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error("ECONNRESET");
        if (calls === 2) return fail(503, "ocupado");
        return ok(claimed("t1"));
      },
    });
    expect(task.taskId).toBe("t1");
    expect(calls).toBe(3);
  });

  it("does not retry 401 and never puts the token in the error", async () => {
    let calls = 0;
    const error = await claimAgentCoreTask(invocation("t1"), {
      sleep: noSleep,
      fetchImpl: async () => {
        calls += 1;
        return fail(401, "token inválido ou já usado");
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerClientError);
    expect((error as WorkerClientError).status).toBe(401);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(calls).toBe(1);
  });

  it("rejects a ClaimedTask for another task", async () => {
    await expect(claimAgentCoreTask(invocation("t1"), { fetchImpl: async () => ok(claimed("t9")) })).rejects.toThrow(/outra tarefa/);
  });

  it("gives up after the configured attempts", async () => {
    let calls = 0;
    await expect(
      claimAgentCoreTask(invocation("t1"), {
        sleep: noSleep,
        attempts: 3,
        fetchImpl: async () => {
          calls += 1;
          return fail(500, "x");
        },
      }),
    ).rejects.toBeInstanceOf(WorkerClientError);
    expect(calls).toBe(3);
  });
});

describe("readEntryConfig", () => {
  it("refuses to start without CARBON_PANEL_URL", () => {
    const parsed = readEntryConfig({});
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/CARBON_PANEL_URL é obrigatório/);
  });

  it("defaults to port 8080", () => {
    const parsed = readEntryConfig({ CARBON_PANEL_URL: "https://painel.exemplo.test" });
    expect(parsed.ok && parsed.config.port).toBe(8080);
  });

  it.each([
    ["http://painel.exemplo.test", /https/],
    ["https://10.0.0.5", /privado/],
    ["https://169.254.169.254", /privado/],
    ["https://[::ffff:192.168.0.1]", /privado/],
    ["https://[fd00::1]", /privado/],
  ])("rejects CARBON_PANEL_URL=%s (SSRF / plain http)", (url, message) => {
    const parsed = readEntryConfig({ CARBON_PANEL_URL: url });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(message);
  });

  it("accepts loopback http for local development", () => {
    expect(readEntryConfig({ CARBON_PANEL_URL: "http://127.0.0.1:3000" }).ok).toBe(true);
    expect(readEntryConfig({ CARBON_PANEL_URL: "http://localhost:3000" }).ok).toBe(true);
  });

  it("reads CARBON_GIT_HOSTS and removes the tokens from the environment at startup (scrubSecretEnv)", async () => {
    const parsed = readEntryConfig({ CARBON_PANEL_URL: "https://p.test", CARBON_GIT_HOSTS: "GitHub.com, gitlab.example.com:8443" });
    expect(parsed.ok && parsed.config.gitHosts).toEqual(["github.com", "gitlab.example.com:8443"]);
    const { scrubSecretEnv } = await import("./config");
    const env: NodeJS.ProcessEnv = { CARBON_GIT_TOKEN: "g", CARBON_WORKER_TOKEN: "cwk_x", PATH: "/bin" } as NodeJS.ProcessEnv;
    scrubSecretEnv(env);
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("reads PORT, grace and pins the panel origin", () => {
    const parsed = readEntryConfig({ PORT: "9090", CARBON_WORKER_GRACE_SECONDS: "5", CARBON_PANEL_URL: "https://painel.exemplo.test/x", CARBON_GIT_TOKEN: " g " });
    expect(parsed).toMatchObject({ ok: true, config: { port: 9090, graceSeconds: 5, allowedPanelOrigin: "https://painel.exemplo.test", gitToken: "g" } });
  });

  it("reports invalid values", () => {
    const parsed = readEntryConfig({ PORT: "0", CARBON_PANEL_URL: "nope" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors).toHaveLength(2);
  });
});
