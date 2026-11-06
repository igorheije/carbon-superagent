import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutorEvent } from "../shared/executors/events";
import { PROTOCOL_VERSION, type ClaimedTask } from "../shared/worker-protocol";
import {
  BACKOFF_CAP_MS,
  backoffMs,
  BundleTooLarge,
  createWorkerClient,
  eventBytes,
  ProtocolTooOld,
  trimToCap,
  WorkerClientError,
  type FetchLike,
} from "./client";

const TOKEN = "cwk_secret-token-value";
const PANEL = "https://panel.test/";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly json: { seq?: number; events?: ExecutorEvent[] } & Record<string, unknown>;
}

type Responder = (call: Call, index: number) => Response | Promise<Response>;

const envelope = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data: status < 400 ? data : null, error: status < 400 ? null : String(data) }), {
    status,
    headers: { "content-type": "application/json" },
  });

const networkDown = () => Promise.reject(new TypeError("fetch failed"));

function fakeFetch(responder: Responder): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    const json = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const call = { url, init, json };
    calls.push(call);
    return responder(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

/** Echoes acceptedSeq like the panel does. */
const ackEvents: Responder = (call) => envelope({ acceptedSeq: call.json.seq });

function makeClient(responder: Responder, sleeps: number[] = []) {
  const { fetchImpl, calls } = fakeFetch(responder);
  const client = createWorkerClient({
    panelUrl: PANEL,
    token: TOKEN,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => 1234,
  });
  return { client, calls, sleeps };
}

const text = (t: string): ExecutorEvent => ({ type: "text", text: t });
const texts = (calls: Call[]) => calls.flatMap((c) => (c.json.events ?? []).map((e) => (e.type === "text" ? e.text : e.type)));

describe("worker client — events", () => {
  it("retries on network failure and 5xx keeping seq and order", async () => {
    const { client, calls, sleeps } = makeClient((call, index) => {
      if (index === 0) return networkDown();
      if (index === 1) return envelope("indisponível", 503);
      return ackEvents(call, index);
    });

    client.sendEvents("t1", [text("a"), text("b")]);
    client.sendEvents("t1", [text("c")]);
    expect(await client.flush("t1")).toBe("ok");

    // The first batch is resent unchanged (same seq, same events) until acked; "c" follows in order.
    expect(calls.map((c) => c.json.seq)).toEqual([1, 1, 1, 2]);
    expect(calls[0].json.events).toEqual(calls[2].json.events);
    expect(texts(calls.slice(2))).toEqual(["a", "b", "c"]);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
    expect(client.eventStats("t1")).toMatchObject({ pendingEvents: 0, bufferedBytes: 0, lastAckAt: 1234 });
  });

  it("does not resend acked events", async () => {
    const { client, calls } = makeClient(ackEvents);

    client.sendEvents("t1", [text("a")]);
    await client.flush("t1");
    client.sendEvents("t1", [text("b")]);
    await client.flush("t1");

    expect(calls.map((c) => c.json.seq)).toEqual([1, 2]);
    expect(texts(calls)).toEqual(["a", "b"]);
    expect(calls[0].url).toBe("https://panel.test/api/worker/tasks/t1/events");
  });

  it("splits large inputs into batches of at most MAX_EVENTS_PER_BATCH", async () => {
    const { client, calls } = makeClient(ackEvents);
    client.sendEvents("t1", Array.from({ length: 1200 }, (_, i) => text(String(i))));
    await client.flush("t1");
    expect(calls.map((c) => c.json.events?.length)).toEqual([500, 500, 200]);
    expect(calls.map((c) => c.json.seq)).toEqual([1, 2, 3]);
  });

  it("stops on 409 lease_lost and surfaces it", async () => {
    const { client, calls } = makeClient(() => envelope("lease_lost", 409));

    expect(client.sendEvents("t1", [text("a")])).toBe("queued");
    expect(await client.flush("t1")).toBe("lease_lost");
    expect(client.sendEvents("t1", [text("b")])).toBe("lease_lost");
    expect(await client.flush("t1")).toBe("lease_lost");
    expect(calls).toHaveLength(1);
  });

  it("fails delivery on a non-retryable 4xx and throws it from flush", async () => {
    const { client, calls } = makeClient(() => envelope("events.0: inválido", 400));
    client.sendEvents("t1", [text("a")]);
    await expect(client.flush("t1")).rejects.toMatchObject({ status: 400, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("rejects events outside the protocol at enqueue time", () => {
    const { client } = makeClient(ackEvents);
    expect(() => client.sendEvents("t1", [text("x".repeat(64_001))])).toThrow(WorkerClientError);
  });

  it("drops oldest text/thinking first when the buffer passes 5 MB, never result/error/usage/plan", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client, calls } = makeClient(async (call, index) => {
      if (index === 0) await gate; // first batch stays in flight while the buffer fills
      return ackEvents(call, index);
    });

    const big = "x".repeat(60_000);
    client.sendEvents("t1", [text("first")]);
    const keep: ExecutorEvent[] = [
      { type: "plan", items: [{ text: "p", done: false }] },
      { type: "usage", tokens: 10, costUsd: null },
      { type: "error", message: "e" },
      { type: "result", isError: false, text: "done" },
    ];
    client.sendEvents("t1", [keep[0], keep[1]]);
    for (let i = 0; i < 100; i++) client.sendEvents("t1", [i % 2 ? text(`${i}:${big}`) : { type: "thinking", text: `${i}:${big}` }]);
    client.sendEvents("t1", [keep[2], keep[3]]);

    const stats = client.eventStats("t1");
    expect(stats?.dropped).toBeGreaterThan(0);
    expect(stats?.bufferedBytes).toBeLessThanOrEqual(5 * 1024 * 1024);

    release!();
    expect(await client.flush("t1")).toBe("ok");
    const delivered = calls.flatMap((c) => c.json.events ?? []);
    for (const event of keep) expect(delivered).toContainEqual(event);
    // The oldest big events went first: the newest one survived, event 0 did not.
    const bigOnes = delivered.filter((e) => (e.type === "text" || e.type === "thinking") && e.text.length > 1000);
    expect(bigOnes.length).toBe(100 - (stats?.dropped ?? 0));
    expect(bigOnes.at(-1)).toMatchObject({ text: expect.stringMatching(/^99:/) });
    expect(bigOnes[0]).not.toMatchObject({ text: expect.stringMatching(/^0:/) });
    // Batches stay under the 1 MB JSON body cap.
    for (const call of calls) expect(Buffer.byteLength(String(call.init.body))).toBeLessThan(1024 * 1024);
  });

  it("discard stops retries", async () => {
    const { client, calls } = makeClient(() => networkDown());
    client.sendEvents("t1", [text("a")]);
    await Promise.resolve();
    client.discard("t1");
    expect(await client.flush("t1")).toBe("ok");
    expect(client.eventStats("t1")).toBeNull();
    expect(calls.length).toBeLessThanOrEqual(2);
  });
});

describe("worker client — pure helpers", () => {
  it("trimToCap drops text/thinking before tool and keeps the rest", () => {
    const items = [
      { event: { type: "tool", name: "Bash", summary: "s", path: null } as ExecutorEvent, bytes: 10 },
      { event: text("a"), bytes: 10 },
      { event: { type: "result", isError: false, text: "r" } as ExecutorEvent, bytes: 10 },
      { event: { type: "thinking", text: "t" } as ExecutorEvent, bytes: 10 },
    ];
    expect(trimToCap(items, 0, 40)).toEqual({ pending: items, dropped: 0 });
    expect(trimToCap(items, 0, 30).pending.map((q) => q.event.type)).toEqual(["tool", "result", "thinking"]);
    expect(trimToCap(items, 0, 20).pending.map((q) => q.event.type)).toEqual(["tool", "result"]);
    expect(trimToCap(items, 0, 0).pending.map((q) => q.event.type)).toEqual(["result"]);
  });

  it("backoff grows exponentially with jitter and caps at 30 s", () => {
    expect(backoffMs(0, () => 0)).toBe(250);
    expect(backoffMs(1, () => 0)).toBe(500);
    expect(backoffMs(30, () => 0.999)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(backoffMs(30, () => 0)).toBe(BACKOFF_CAP_MS / 2);
  });

  it("eventBytes is the UTF-8 JSON size", () => {
    expect(eventBytes(text("é"))).toBe(Buffer.byteLength('{"type":"text","text":"é"}'));
  });
});

const claimed: ClaimedTask = {
  taskId: "t1",
  key: "CAR-1",
  leaseMs: 60_000,
  executor: "claude",
  model: { model: null, effort: null, label: "padrão", reason: "" },
  prompt: "faça",
  resume: null,
  code: { transport: "bundle", baseRef: "main", branch: "agent/car-1", bundleUrl: "/api/worker/tasks/t1/bundle" },
  limits: { maxRunMinutes: 30 },
  permissionRules: [],
  settings: { permissionProfile: "guarded", isolateClaudeConfig: true, approvalPolicy: "ask" },
  files: [],
};

describe("worker client — calls", () => {
  it("sends Bearer token, User-Agent and protocol version on hello", async () => {
    const { client, calls } = makeClient(() => envelope({ protocol: 1, leaseMs: 60_000, pollMs: 2_000 }));
    expect(await client.hello({ executors: ["claude"], git: true, maxParallel: 1 })).toEqual({ protocol: 1, leaseMs: 60_000, pollMs: 2_000 });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["user-agent"]).toBe(`carbon-worker/${PROTOCOL_VERSION}`);
    expect(calls[0].json).toMatchObject({ version: PROTOCOL_VERSION, executors: ["claude"] });
  });

  it("426 becomes a typed ProtocolTooOld", async () => {
    const { client } = makeClient(() => envelope("protocolo 0 desatualizado", 426));
    const err = await client.hello({ executors: [], git: false, maxParallel: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolTooOld);
    expect((err as Error).message).toContain("desatualizado");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("claim: 204 → null, ClaimedTask validated, abort → null", async () => {
    const empty = makeClient(() => new Response(null, { status: 204 }));
    expect(await empty.client.claim(["claude"])).toBeNull();

    const full = makeClient(() => envelope(claimed));
    expect(await full.client.claim(["claude"])).toEqual(claimed);

    const bad = makeClient(() => envelope({ taskId: "t1" }));
    await expect(bad.client.claim(["claude"])).rejects.toBeInstanceOf(WorkerClientError);

    const controller = new AbortController();
    const aborted = makeClient(() => {
      controller.abort();
      return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
    expect(await aborted.client.claim(["claude"], controller.signal)).toBeNull();
  });

  it("heartbeat returns cancel flag or lease_lost", async () => {
    expect(await makeClient(() => envelope({ cancel: true })).client.heartbeat("t1")).toEqual({ cancel: true });
    expect(await makeClient(() => envelope("lease_lost", 409)).client.heartbeat("t1")).toBe("lease_lost");
    await expect(makeClient(() => envelope("x", 503)).client.heartbeat("t1")).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it("result validates the request and posts it", async () => {
    const { client, calls } = makeClient(() => envelope({ ok: true }));
    expect(await client.result("t1", { status: "done", branch: "agent/x", commit: "abc", transport: "push" })).toBe("ok");
    expect(calls[0].url).toBe("https://panel.test/api/worker/tasks/t1/result");
    expect(calls[0].json).toMatchObject({ status: "done", transport: "push" });
  });

  it("rejects a missing token without echoing it", () => {
    expect(() => createWorkerClient({ panelUrl: PANEL, token: "" })).toThrow(WorkerClientError);
    expect(() => createWorkerClient({ panelUrl: "ftp://x", token: TOKEN })).toThrow(/http/);
  });
});

describe("worker client — bundles", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "carbon-client-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const payload = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));

  it("downloads the bundle stream to disk", async () => {
    const { client, calls } = makeClient(() => {
      const chunks = [payload.subarray(0, 100_000), payload.subarray(100_000)];
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.shift();
          if (next) controller.enqueue(new Uint8Array(next));
          else controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
    });
    const dest = join(dir, "base.bundle");
    expect(await client.downloadBundle("t1", dest)).toBe("ok");
    expect((await readFile(dest)).equals(payload)).toBe(true);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].url).toBe("https://panel.test/api/worker/tasks/t1/bundle");
  });

  it("download: lease_lost passes through", async () => {
    const { client } = makeClient(() => envelope("lease_lost", 409));
    expect(await client.downloadBundle("t1", join(dir, "x.bundle"))).toBe("lease_lost");
  });

  it("uploads the bundle as a stream from disk", async () => {
    const file = join(dir, "result.bundle");
    await writeFile(file, payload);
    let received = Buffer.alloc(0);
    const { client, calls } = makeClient(async (call) => {
      expect(call.init.body).toBeInstanceOf(ReadableStream);
      received = Buffer.from(await new Response(call.init.body).arrayBuffer());
      return envelope({ bytes: received.length });
    });
    expect(await client.uploadBundle("t1", file)).toBe("ok");
    expect(received.equals(payload)).toBe(true);
    expect(calls[0].init.method).toBe("PUT");
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe("application/octet-stream");
  });

  it("upload: 413 becomes BundleTooLarge", async () => {
    const file = join(dir, "result.bundle");
    await writeFile(file, payload);
    const { client } = makeClient(async (call) => {
      await new Response(call.init.body).arrayBuffer();
      return envelope("resultado maior que 200 MB", 413);
    });
    await expect(client.uploadBundle("t1", file)).rejects.toBeInstanceOf(BundleTooLarge);
  });
});
