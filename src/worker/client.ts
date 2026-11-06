import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { z } from "zod";
import type { ExecutorEvent } from "../shared/executors/events";
import {
  bundlePath,
  claimedTaskSchema,
  eventsResponseSchema,
  executorEventSchema,
  heartbeatResponseSchema,
  helloResponseSchema,
  LEASE_LOST,
  MAX_EVENTS_PER_BATCH,
  MAX_JSON_BODY_BYTES,
  PROTOCOL_VERSION,
  resultPath,
  resultRequestSchema,
  type ClaimedTask,
  type HeartbeatResponse,
  type HelloRequest,
  type HelloResponse,
  type ResultRequest,
} from "../shared/worker-protocol";

/**
 * HTTP client for the worker side of the panel protocol (/api/worker/*). Plain Node: no
 * `server-only`, DB or Next imports. It never logs, and the token only ever goes into the
 * Authorization header — never into an error message.
 */

export const USER_AGENT = `carbon-worker/${PROTOCOL_VERSION}`;
/** Unacked events kept per task; above it the oldest low-value events are dropped. */
export const EVENT_BUFFER_CAP_BYTES = 5 * 1024 * 1024;
/** Serialized events per batch, leaving room for the `{seq, events}` wrapper under the 1 MB body cap. */
export const BATCH_BYTE_BUDGET = MAX_JSON_BODY_BYTES - 4 * 1024;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;

/** Dropped first when the buffer is full, tier by tier, oldest first. Anything else is kept. */
const DROP_TIERS: readonly (readonly ExecutorEvent["type"][])[] = [["text", "thinking"], ["tool"]];

const HELLO_PATH = "/api/worker/hello";
const CLAIM_PATH = "/api/worker/claim";
const taskPath = (taskId: string, leaf: string) => `/api/worker/tasks/${encodeURIComponent(taskId)}/${leaf}`;

// ---------------------------------------------------------------- errors

export class WorkerClientError extends Error {
  constructor(
    message: string,
    /** HTTP status, or null for network failures. */
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WorkerClientError";
  }
}

/** 426: the panel requires a newer protocol; the worker must be updated. */
export class ProtocolTooOld extends WorkerClientError {
  constructor(message: string) {
    super(message, 426, false);
    this.name = "ProtocolTooOld";
  }
}

/** 413 on bundle upload: the result is larger than `settings.workers.maxBundleMb`. */
export class BundleTooLarge extends WorkerClientError {
  constructor(message: string) {
    super(message, 413, false);
    this.name = "BundleTooLarge";
  }
}

// ---------------------------------------------------------------- options and API

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface WorkerClientOptions {
  readonly panelUrl: string;
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: SleepFn;
  readonly now?: () => number;
  /** Jitter source in [0, 1). */
  readonly random?: () => number;
}

export type HelloCaps = Omit<HelloRequest, "version">;
export type LeaseLost = typeof LEASE_LOST;
export type Delivery = "ok" | LeaseLost;

export interface EventStats {
  readonly pendingEvents: number;
  readonly bufferedBytes: number;
  readonly dropped: number;
  readonly lastAckAt: number | null;
}

export interface WorkerClient {
  hello(caps: HelloCaps): Promise<HelloResponse>;
  /** Long-poll. null when nothing showed up (204) or when `signal` aborted the wait. */
  claim(executors: ClaimedTask["executor"][], signal?: AbortSignal): Promise<ClaimedTask | null>;
  heartbeat(taskId: string): Promise<HeartbeatResponse | LeaseLost>;
  /** Queues events and starts delivering them in the background. "lease_lost" once the panel said so. */
  sendEvents(taskId: string, events: readonly ExecutorEvent[]): "queued" | LeaseLost;
  /** Waits until every queued event is acked. Throws the non-retryable error that stopped delivery. */
  flush(taskId: string): Promise<Delivery>;
  /** Forgets a task's buffer and stops its retries. */
  discard(taskId: string): void;
  eventStats(taskId: string): EventStats | null;
  downloadBundle(taskId: string, destFile: string): Promise<Delivery>;
  uploadBundle(taskId: string, file: string): Promise<Delivery>;
  result(taskId: string, req: ResultRequest): Promise<Delivery>;
}

// ---------------------------------------------------------------- pure helpers

const envelopeSchema = z.object({ success: z.boolean(), data: z.unknown(), error: z.string().nullable() });

export const eventBytes = (event: ExecutorEvent): number => Buffer.byteLength(JSON.stringify(event), "utf8");

/** Exponential backoff with jitter in [d/2, d), capped at BACKOFF_CAP_MS. */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 16));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

export interface Queued {
  readonly event: ExecutorEvent;
  readonly bytes: number;
}

/**
 * Drops the oldest droppable events (text/thinking, then tool) from `pending` until
 * `fixedBytes + pending` fits in `cap`. result/error/usage/plan and the rest are never dropped.
 */
export function trimToCap(pending: readonly Queued[], fixedBytes: number, cap: number): { pending: readonly Queued[]; dropped: number } {
  const total = pending.reduce((sum, item) => sum + item.bytes, fixedBytes);
  let excess = total - cap;
  if (excess <= 0) return { pending, dropped: 0 };
  const drop = new Set<number>();
  for (const tier of DROP_TIERS) {
    for (let i = 0; i < pending.length && excess > 0; i++) {
      if (!drop.has(i) && tier.includes(pending[i].event.type)) {
        drop.add(i);
        excess -= pending[i].bytes;
      }
    }
  }
  return { pending: pending.filter((_, i) => !drop.has(i)), dropped: drop.size };
}

/** Next batch: at most MAX_EVENTS_PER_BATCH events and BATCH_BYTE_BUDGET bytes (never empty). */
export function takeBatch(pending: readonly Queued[]): { batch: readonly Queued[]; rest: readonly Queued[] } {
  let bytes = 0;
  let count = 0;
  while (count < pending.length && count < MAX_EVENTS_PER_BATCH) {
    const next = bytes + pending[count].bytes;
    if (count > 0 && next > BATCH_BYTE_BUDGET) break;
    bytes = next;
    count++;
  }
  return { batch: pending.slice(0, count), rest: pending.slice(count) };
}

const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

const isAbort = (err: unknown) => err instanceof Error && err.name === "AbortError";
const isRetryableStatus = (status: number) => status >= 500 || status === 408 || status === 429;
const isRetryable = (err: unknown) => err instanceof WorkerClientError && err.retryable;

function normalizeBaseUrl(panelUrl: string): string {
  let url: URL;
  try {
    url = new URL(panelUrl);
  } catch {
    throw new WorkerClientError("panelUrl inválida", null, false);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WorkerClientError("panelUrl precisa ser http(s)", null, false);
  return url.toString().replace(/\/+$/, "");
}

// ---------------------------------------------------------------- event stream state

interface Batch {
  readonly seq: number;
  readonly events: readonly ExecutorEvent[];
  readonly bytes: number;
}

interface Stream {
  nextSeq: number;
  pending: readonly Queued[];
  inflight: Batch | null;
  dropped: number;
  lastAckAt: number | null;
  state: "open" | "lease_lost" | "failed" | "discarded";
  failure: Error | null;
  draining: Promise<void> | null;
  readonly stop: AbortController;
}

const newStream = (): Stream => ({
  nextSeq: 1,
  pending: [],
  inflight: null,
  dropped: 0,
  lastAckAt: null,
  state: "open",
  failure: null,
  draining: null,
  stop: new AbortController(),
});

const bufferedBytes = (s: Stream) => s.pending.reduce((sum, item) => sum + item.bytes, s.inflight?.bytes ?? 0);

// ---------------------------------------------------------------- client

type Outcome = { readonly kind: "ok"; readonly data: unknown } | { readonly kind: "empty" } | { readonly kind: "lease_lost" };

export function createWorkerClient(options: WorkerClientOptions): WorkerClient {
  if (!options.token || /\s/.test(options.token)) throw new WorkerClientError("token do worker ausente ou inválido", null, false);
  const baseUrl = normalizeBaseUrl(options.panelUrl);
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const authorization = `Bearer ${options.token}`;
  const streams = new Map<string, Stream>();

  async function send(method: string, path: string, init: { body?: BodyInit; contentType?: string; signal?: AbortSignal; stream?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization, "user-agent": USER_AGENT, accept: "application/json" };
    if (init.contentType) headers["content-type"] = init.contentType;
    const request: RequestInit & { duplex?: "half" } = { method, headers, body: init.body, signal: init.signal };
    if (init.stream) request.duplex = "half";
    try {
      return await fetchImpl(`${baseUrl}${path}`, request);
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new WorkerClientError(`falha de rede ao chamar ${path}: ${err instanceof Error ? err.message : String(err)}`, null, true);
    }
  }

  async function errorMessage(res: Response): Promise<string> {
    const text = await res.text().catch(() => "");
    try {
      const parsed = envelopeSchema.safeParse(JSON.parse(text));
      if (parsed.success && parsed.data.error) return parsed.data.error.slice(0, 500);
    } catch {
      // not JSON: fall through to the status line
    }
    return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  }

  /** Maps a non-2xx response to lease_lost or a typed error. */
  async function classify(res: Response, path: string): Promise<{ readonly kind: "lease_lost" }> {
    const message = await errorMessage(res);
    if (res.status === 426) throw new ProtocolTooOld(message);
    if (res.status === 409 && message === LEASE_LOST) return { kind: "lease_lost" };
    if (res.status === 413) throw new BundleTooLarge(message);
    throw new WorkerClientError(`${path}: ${message}`, res.status, isRetryableStatus(res.status));
  }

  async function readEnvelope(res: Response, path: string): Promise<unknown> {
    const parsed = envelopeSchema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success || !parsed.data.success) throw new WorkerClientError(`${path}: resposta fora do protocolo`, res.status, false);
    return parsed.data.data;
  }

  async function callJson(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<Outcome> {
    const res = await send(method, path, { body: JSON.stringify(body), contentType: "application/json", signal });
    if (res.status === 204) return { kind: "empty" };
    if (!res.ok) return classify(res, path);
    return { kind: "ok", data: await readEnvelope(res, path) };
  }

  function validate<S extends z.ZodTypeAny>(schema: S, data: unknown, path: string): z.infer<S> {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new WorkerClientError(`${path}: resposta inválida (${issue?.path.join(".") || "data"}: ${issue?.message ?? "?"})`, null, false);
    }
    return parsed.data;
  }

  async function okOrLeaseLost(outcome: Outcome): Promise<Delivery> {
    return outcome.kind === "lease_lost" ? LEASE_LOST : "ok";
  }

  // -------------------------------------------------------------- events

  async function deliverBatch(taskId: string, s: Stream, batch: Batch): Promise<void> {
    const path = taskPath(taskId, "events");
    const outcome = await callJson("POST", path, { seq: batch.seq, events: batch.events });
    if (s.state !== "open") return;
    if (outcome.kind === "lease_lost") {
      s.state = "lease_lost";
      s.pending = [];
      s.inflight = null;
      return;
    }
    if (outcome.kind === "empty") throw new WorkerClientError(`${path}: resposta vazia`, 204, true);
    validate(eventsResponseSchema, outcome.data, path);
    s.inflight = null;
    s.lastAckAt = now();
  }

  async function drain(taskId: string, s: Stream): Promise<void> {
    let attempt = 0;
    while (s.state === "open") {
      if (!s.inflight) {
        if (s.pending.length === 0) return;
        const { batch, rest } = takeBatch(s.pending);
        s.inflight = { seq: s.nextSeq, events: batch.map((q) => q.event), bytes: batch.reduce((sum, q) => sum + q.bytes, 0) };
        s.nextSeq += 1;
        s.pending = rest;
      }
      try {
        await deliverBatch(taskId, s, s.inflight);
        attempt = 0;
      } catch (err) {
        if (s.state !== "open") return;
        if (!isRetryable(err)) {
          s.state = "failed";
          s.failure = err instanceof Error ? err : new Error(String(err));
          return;
        }
        await sleep(backoffMs(attempt, random), s.stop.signal).catch(() => undefined);
        attempt += 1;
      }
    }
  }

  function kick(taskId: string, s: Stream): void {
    if (s.draining || s.state !== "open") return;
    s.draining = drain(taskId, s).finally(() => {
      s.draining = null;
      if (s.state === "open" && (s.inflight || s.pending.length > 0)) kick(taskId, s);
    });
  }

  function sendEvents(taskId: string, events: readonly ExecutorEvent[]): "queued" | LeaseLost {
    const s = streams.get(taskId) ?? newStream();
    streams.set(taskId, s);
    if (s.state === "lease_lost") return LEASE_LOST;
    if (s.state !== "open") return "queued";
    const queued = events.map((event, index): Queued => {
      const parsed = executorEventSchema.safeParse(event);
      if (!parsed.success) throw new WorkerClientError(`evento ${index} (${event.type}) fora do protocolo: ${parsed.error.issues[0]?.message ?? "inválido"}`, null, false);
      return { event, bytes: eventBytes(event) };
    });
    const trimmed = trimToCap([...s.pending, ...queued], s.inflight?.bytes ?? 0, EVENT_BUFFER_CAP_BYTES);
    s.pending = trimmed.pending;
    s.dropped += trimmed.dropped;
    kick(taskId, s);
    return "queued";
  }

  async function flush(taskId: string): Promise<Delivery> {
    const s = streams.get(taskId);
    if (!s) return "ok";
    while (s.draining) await s.draining;
    if (s.state === "lease_lost") return LEASE_LOST;
    if (s.state === "failed" && s.failure) throw s.failure;
    return "ok";
  }

  function discard(taskId: string): void {
    const s = streams.get(taskId);
    if (!s) return;
    s.state = "discarded";
    s.stop.abort();
    streams.delete(taskId);
  }

  function eventStats(taskId: string): EventStats | null {
    const s = streams.get(taskId);
    if (!s) return null;
    return { pendingEvents: s.pending.length + (s.inflight?.events.length ?? 0), bufferedBytes: bufferedBytes(s), dropped: s.dropped, lastAckAt: s.lastAckAt };
  }

  // -------------------------------------------------------------- calls

  return {
    async hello(caps) {
      const outcome = await callJson("POST", HELLO_PATH, { ...caps, version: PROTOCOL_VERSION });
      if (outcome.kind !== "ok") throw new WorkerClientError(`${HELLO_PATH}: resposta inesperada`, null, false);
      return validate(helloResponseSchema, outcome.data, HELLO_PATH);
    },

    async claim(executors, signal) {
      try {
        const outcome = await callJson("POST", CLAIM_PATH, { executors }, signal);
        if (outcome.kind === "empty") return null;
        if (outcome.kind === "lease_lost") throw new WorkerClientError(`${CLAIM_PATH}: resposta inesperada`, 409, false);
        return validate(claimedTaskSchema, outcome.data, CLAIM_PATH);
      } catch (err) {
        if (signal?.aborted && isAbort(err)) return null;
        throw err;
      }
    },

    async heartbeat(taskId) {
      const path = taskPath(taskId, "heartbeat");
      const outcome = await callJson("POST", path, {});
      if (outcome.kind === "lease_lost") return LEASE_LOST;
      if (outcome.kind === "empty") throw new WorkerClientError(`${path}: resposta vazia`, 204, true);
      return validate(heartbeatResponseSchema, outcome.data, path);
    },

    sendEvents,
    flush,
    discard,
    eventStats,

    async downloadBundle(taskId, destFile) {
      const path = bundlePath(taskId);
      const res = await send("GET", path);
      if (!res.ok) return okOrLeaseLost(await classify(res, path));
      if (!res.body) throw new WorkerClientError(`${path}: bundle vazio`, res.status, true);
      try {
        await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream), createWriteStream(destFile));
      } catch (err) {
        await rm(destFile, { force: true });
        throw new WorkerClientError(`${path}: download interrompido: ${err instanceof Error ? err.message : String(err)}`, null, true);
      }
      return "ok";
    },

    async uploadBundle(taskId, file) {
      const path = bundlePath(taskId);
      const body = Readable.toWeb(createReadStream(file)) as unknown as BodyInit;
      const res = await send("PUT", path, { body, contentType: "application/octet-stream", stream: true });
      if (!res.ok) return okOrLeaseLost(await classify(res, path));
      await readEnvelope(res, path);
      return "ok";
    },

    async result(taskId, req) {
      const path = resultPath(taskId);
      const outcome = await callJson("POST", path, resultRequestSchema.parse(req));
      return okOrLeaseLost(outcome);
    },
  };
}
