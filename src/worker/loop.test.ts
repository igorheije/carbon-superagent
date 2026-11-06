import { describe, expect, it } from "vitest";
import type { ClaimedTask, HelloResponse } from "../shared/worker-protocol";
import { ProtocolTooOld, WorkerClientError, type WorkerClient } from "./client";
import { readWorkerConfig } from "./config";
import { EXIT_FATAL, EXIT_OK, EXIT_PROTOCOL, runWorkerLoop, type WorkerLoopOptions } from "./loop";
import type { RunOutcome, RunTaskDeps } from "./run-task";

const HELLO: HelloResponse = { protocol: 1, leaseMs: 60_000, pollMs: 25_000 };

function claimed(n: number): ClaimedTask {
  return {
    taskId: `t${n}`,
    key: `CAR-${n}`,
    leaseMs: 60_000,
    executor: "claude",
    model: { model: null, effort: null, label: "auto", reason: "teste" },
    prompt: "p",
    resume: null,
    code: { transport: "bundle", baseRef: "main", branch: `agent/car-${n}`, bundleUrl: "/x" },
    limits: { maxRunMinutes: 10 },
    permissionRules: [],
    settings: { permissionProfile: "guarded", isolateClaudeConfig: false, approvalPolicy: "ask" },
    files: [],
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A client whose claim hands out `tasks` in order, then long-polls (until aborted). */
function fakeClient(tasks: ClaimedTask[], hello: () => Promise<HelloResponse> = async () => HELLO): WorkerClient & { claims: number } {
  const queue = [...tasks];
  const client = {
    claims: 0,
    hello,
    async claim(_executors: unknown, signal?: AbortSignal) {
      client.claims += 1;
      const next = queue.shift();
      if (next) return next;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(resolve, 50);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return null;
    },
    heartbeat: async () => ({ cancel: false }),
    sendEvents: () => "queued" as const,
    flush: async () => "ok" as const,
    discard: () => undefined,
    eventStats: () => null,
    downloadBundle: async () => "ok" as const,
    uploadBundle: async () => "ok" as const,
    result: async () => "ok" as const,
    permissions: async () => ({ decisions: [] }),
  };
  return client;
}

function options(client: WorkerClient, runTask: WorkerLoopOptions["runTask"], signal: AbortSignal, extra: Partial<WorkerLoopOptions> = {}): WorkerLoopOptions {
  return {
    panelUrl: "http://panel.test",
    token: "cwk_x",
    executors: ["claude"],
    parallel: 1,
    workDir: "/tmp/nao-usado",
    graceSeconds: 5,
    signal,
    client,
    runTask,
    ...extra,
  };
}

describe("runWorkerLoop", () => {
  it("claim → run → graceful shutdown waits for the running task", async () => {
    const controller = new AbortController();
    const seen: { key: string; aborted: boolean }[] = [];
    const runTask = async (task: ClaimedTask, deps: RunTaskDeps): Promise<RunOutcome> => {
      controller.abort(); // SIGTERM arrives while the task runs
      await wait(150);
      seen.push({ key: task.key, aborted: deps.signal?.aborted ?? false });
      return "done";
    };
    const client = fakeClient([claimed(1), claimed(2)]);
    expect(await runWorkerLoop(options(client, runTask, controller.signal))).toBe(EXIT_OK);
    expect(seen).toEqual([{ key: "CAR-1", aborted: false }]);
    expect(client.claims).toBe(1);
  });

  it("cancels running tasks when the grace period is over", async () => {
    const controller = new AbortController();
    const outcomes: RunOutcome[] = [];
    const runTask = (_task: ClaimedTask, deps: RunTaskDeps) =>
      new Promise<RunOutcome>((resolve) => {
        controller.abort();
        deps.signal?.addEventListener("abort", () => {
          outcomes.push("canceled");
          resolve("canceled");
        }, { once: true });
      });
    const started = Date.now();
    expect(await runWorkerLoop(options(fakeClient([claimed(1)]), runTask, controller.signal, { graceSeconds: 0 }))).toBe(EXIT_OK);
    expect(outcomes).toEqual(["canceled"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("426 on hello → exit code 2 without claiming", async () => {
    const client = fakeClient([claimed(1)], async () => {
      throw new ProtocolTooOld("protocolo 1 desatualizado; o painel exige 2");
    });
    const logs: string[] = [];
    const code = await runWorkerLoop(options(client, async () => "done", new AbortController().signal, { log: (l) => logs.push(l) }));
    expect(code).toBe(EXIT_PROTOCOL);
    expect(client.claims).toBe(0);
    expect(logs.at(-1)).toMatch(/o painel exige um worker mais novo/);
  });

  it("hello retries network errors; a refused token is fatal (exit 1)", async () => {
    let calls = 0;
    const flaky = fakeClient([], async () => {
      calls += 1;
      if (calls < 3) throw new WorkerClientError("falha de rede", null, true);
      throw new WorkerClientError("não autorizado", 401, false);
    });
    const fastRetry = { sleep: async () => void (await wait(5)) };
    expect(await runWorkerLoop(options(flaky, async () => "done", new AbortController().signal, fastRetry))).toBe(EXIT_FATAL);
    expect(calls).toBe(3);
  });

  it("parallel=2 runs two tasks at the same time", async () => {
    const controller = new AbortController();
    let active = 0;
    let peak = 0;
    let finished = 0;
    const runTask = async (): Promise<RunOutcome> => {
      active += 1;
      peak = Math.max(peak, active);
      await wait(200);
      active -= 1;
      finished += 1;
      if (finished === 2) controller.abort();
      return "done";
    };
    expect(await runWorkerLoop(options(fakeClient([claimed(1), claimed(2)]), runTask, controller.signal, { parallel: 2 }))).toBe(EXIT_OK);
    expect(peak).toBe(2);
    expect(finished).toBe(2);
  });
});

describe("readWorkerConfig", () => {
  const base = { CARBON_PANEL_URL: "https://painel.local/", CARBON_WORKER_TOKEN: "cwk_segredo-muito-secreto" };

  it("applies defaults and detects executors only when not set", () => {
    let detected = 0;
    const result = readWorkerConfig(base, () => {
      detected += 1;
      return ["codex"];
    });
    expect(result.ok && result.config).toMatchObject({ panelUrl: "https://painel.local", parallel: 1, graceSeconds: 120, executors: ["codex"], gitToken: undefined });
    expect(result.ok && result.config.workDir).toMatch(/carbon-worker$/);
    expect(detected).toBe(1);
    const explicit = readWorkerConfig({ ...base, CARBON_WORKER_EXECUTORS: "claude, codex", CARBON_WORKER_PARALLEL: "3" }, () => {
      throw new Error("não devia detectar");
    });
    expect(explicit.ok && explicit.config).toMatchObject({ executors: ["claude", "codex"], parallel: 3 });
  });

  it("reports every invalid value and never echoes the token", () => {
    const result = readWorkerConfig(
      { CARBON_PANEL_URL: "ftp://x", CARBON_WORKER_TOKEN: "segredo-sem-prefixo", CARBON_WORKER_PARALLEL: "0", CARBON_WORKER_GRACE_SECONDS: "abc", CARBON_WORKER_EXECUTORS: "gpt" },
      () => [],
    );
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors;
    expect(errors).toHaveLength(5);
    expect(errors.join("\n")).not.toContain("segredo-sem-prefixo");
    expect(readWorkerConfig({}, () => []).ok).toBe(false);
  });
});
