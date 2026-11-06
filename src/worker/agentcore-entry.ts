import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { AGENTCORE_CLAIM_PATH, claimedTaskSchema, MAX_JSON_BODY_BYTES, PROTOCOL_VERSION, type ClaimedTask } from "../shared/worker-protocol";
import { backoffMs, createWorkerClient, ProtocolTooOld, USER_AGENT, WorkerClientError, type FetchLike, type SleepFn, type WorkerClient } from "./client";
import { DEFAULT_GRACE_SECONDS, MAX_GRACE_SECONDS } from "./config";
import { runClaimedTask, type RunOutcome, type RunTaskDeps } from "./run-task";

/**
 * AgentCore Runtime container entrypoint (AGC-02), bundled to dist/agentcore.mjs.
 *
 * AgentCore contract [Certo]: HTTP on port 8080, `POST /invocations`, `GET /ping`, linux/arm64.
 * The panel invokes the runtime with `{taskId, panelUrl, taskToken}`; the container answers 202
 * right away and, in the background, claims that one task with the single-use task token and runs
 * it with the same worker protocol as a pool machine (events, heartbeat, delivery, result). The
 * Invoke stream is never used for progress (it closes after 60 min).
 *
 * One task per container: a second invocation for another task while busy gets 409; the same
 * taskId again gets 202 (AgentCore may retry an invocation). `/ping` reports `HealthyBusy` while a
 * task runs so the session is not reclaimed as idle.
 *
 * Environment: PORT (8080) · CARBON_WORKER_DIR · CARBON_GIT_TOKEN · CARBON_WORKER_GRACE_SECONDS ·
 * CARBON_PANEL_URL (optional: when set, invocations for any other panel origin are refused).
 * The task token and git token are never logged.
 */

export const DEFAULT_PORT = 8080;
const HOST = "0.0.0.0";
/** Claim attempts on network errors / 5xx before giving up on the invocation. */
const CLAIM_ATTEMPTS = 5;

export const invocationSchema = z.object({
  taskId: z.string().min(1).max(200),
  panelUrl: z
    .string()
    .max(2000)
    .refine((raw) => {
      try {
        const url = new URL(raw);
        return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
      } catch {
        return false;
      }
    }, "panelUrl precisa ser uma URL http(s) sem usuário/senha"),
  taskToken: z.string().min(16).max(500).regex(/^\S+$/, "taskToken inválido"),
});
export type Invocation = z.infer<typeof invocationSchema>;

export type PingStatus = "Healthy" | "HealthyBusy";

// ---------------------------------------------------------------- claim (task token)

const envelopeSchema = z.object({ success: z.boolean(), data: z.unknown(), error: z.string().nullable() });

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

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface ClaimOptions {
  readonly fetchImpl?: FetchLike;
  readonly sleep?: SleepFn;
  readonly random?: () => number;
  readonly signal?: AbortSignal;
  readonly attempts?: number;
}

async function claimOnce(invocation: Invocation, fetchImpl: FetchLike, signal?: AbortSignal): Promise<ClaimedTask> {
  const url = `${invocation.panelUrl.replace(/\/+$/, "")}${AGENTCORE_CLAIM_PATH}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${invocation.taskToken}`, "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ taskId: invocation.taskId }),
      signal,
    });
  } catch (error) {
    throw new WorkerClientError(`falha de rede ao chamar ${AGENTCORE_CLAIM_PATH}: ${describe(error)}`, null, true);
  }
  const body: unknown = await res.json().catch(() => undefined);
  const envelope = envelopeSchema.safeParse(body);
  if (!res.ok) {
    const message = envelope.success && envelope.data.error ? envelope.data.error.slice(0, 500) : `HTTP ${res.status}`;
    if (res.status === 426) throw new ProtocolTooOld(message);
    throw new WorkerClientError(`${AGENTCORE_CLAIM_PATH}: ${message}`, res.status, res.status >= 500 || res.status === 408 || res.status === 429);
  }
  if (!envelope.success || !envelope.data.success) throw new WorkerClientError(`${AGENTCORE_CLAIM_PATH}: resposta fora do protocolo`, res.status, false);
  const task = claimedTaskSchema.safeParse(envelope.data.data);
  if (!task.success) throw new WorkerClientError(`${AGENTCORE_CLAIM_PATH}: tarefa inválida (${task.error.issues[0]?.message ?? "?"})`, res.status, false);
  if (task.data.taskId !== invocation.taskId) throw new WorkerClientError(`${AGENTCORE_CLAIM_PATH}: o painel devolveu outra tarefa`, res.status, false);
  return task.data;
}

/** Claims the invoked task with its task token; retries network errors and 5xx with backoff. */
export async function claimAgentCoreTask(invocation: Invocation, options: ClaimOptions = {}): Promise<ClaimedTask> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const attempts = options.attempts ?? CLAIM_ATTEMPTS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await claimOnce(invocation, fetchImpl, options.signal);
    } catch (error) {
      const retryable = error instanceof WorkerClientError && error.retryable;
      if (!retryable || attempt + 1 >= attempts || options.signal?.aborted) throw error;
      await sleep(backoffMs(attempt, options.random ?? Math.random), options.signal);
    }
  }
}

// ---------------------------------------------------------------- server

export interface AgentCoreDeps {
  readonly workDir: string;
  readonly gitToken?: string;
  /** Normalized origin the container accepts invocations for; undefined accepts any. */
  readonly allowedPanelOrigin?: string;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  /** Test hooks. */
  readonly claim?: (invocation: Invocation, signal: AbortSignal) => Promise<ClaimedTask>;
  readonly createClient?: (invocation: Invocation) => WorkerClient;
  readonly runTask?: (task: ClaimedTask, deps: RunTaskDeps) => Promise<RunOutcome>;
}

interface Current {
  readonly taskId: string;
  readonly cancel: AbortController;
  readonly done: Promise<void>;
}

export interface AgentCoreServer {
  readonly server: Server;
  status(): PingStatus;
  currentTaskId(): string | null;
  /** Resolves when no task is running. */
  idle(): Promise<void>;
  /**
   * Graceful stop: refuse new invocations (503), wait up to `graceSeconds` for the running task,
   * then cancel it (run-task reports "canceled"), and close the HTTP server.
   */
  shutdown(graceSeconds: number): Promise<void>;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new HttpFailure(413, "corpo grande demais"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function originOf(panelUrl: string): string {
  return new URL(panelUrl).origin;
}

export function createAgentCoreServer(deps: AgentCoreDeps): AgentCoreServer {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const claim = deps.claim ?? ((invocation, signal) => claimAgentCoreTask(invocation, { signal }));
  const createClient = deps.createClient ?? ((invocation) => createWorkerClient({ panelUrl: invocation.panelUrl, token: invocation.taskToken }));
  const runTask = deps.runTask ?? runClaimedTask;
  let current: Current | null = null;
  let shuttingDown = false;
  let lastUpdate = now();

  const status = (): PingStatus => (current ? "HealthyBusy" : "Healthy");

  async function execute(invocation: Invocation, cancel: AbortController): Promise<void> {
    try {
      const task = await claim(invocation, cancel.signal);
      log(`tarefa ${task.key} recebida (${task.executor})`);
      const outcome = await runTask(task, { client: createClient(invocation), workDir: deps.workDir, gitToken: deps.gitToken, signal: cancel.signal, log });
      log(`tarefa ${task.key} terminou: ${outcome}`);
    } catch (error) {
      log(`tarefa ${invocation.taskId} não executada: ${describe(error)}`);
    }
  }

  function start(invocation: Invocation): void {
    const cancel = new AbortController();
    const done = execute(invocation, cancel).finally(() => {
      current = null;
      lastUpdate = now();
    });
    current = { taskId: invocation.taskId, cancel, done };
    lastUpdate = now();
  }

  async function invocations(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (shuttingDown) throw new HttpFailure(503, "container encerrando");
    let json: unknown;
    try {
      json = JSON.parse(await readBody(req));
    } catch (error) {
      if (error instanceof HttpFailure) throw error;
      throw new HttpFailure(400, "JSON inválido");
    }
    const parsed = invocationSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpFailure(400, `payload inválido (${issue?.path.join(".") || "body"}: ${issue?.message ?? "?"})`);
    }
    const invocation = parsed.data;
    if (deps.allowedPanelOrigin && originOf(invocation.panelUrl) !== deps.allowedPanelOrigin) throw new HttpFailure(403, "panelUrl não autorizada neste container");
    if (current?.taskId === invocation.taskId) return sendJson(res, 202, { accepted: true, taskId: invocation.taskId });
    if (current) throw new HttpFailure(409, "container ocupado com outra tarefa");
    start(invocation);
    log(`invocação aceita para a tarefa ${invocation.taskId}`);
    sendJson(res, 202, { accepted: true, taskId: invocation.taskId });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = (req.url ?? "/").split("?")[0];
    if (route === "/ping") {
      if (req.method !== "GET") throw new HttpFailure(405, "método não permitido");
      // time_of_last_update (epoch seconds) follows the AgentCore ping format [Provável].
      return sendJson(res, 200, { status: status(), time_of_last_update: Math.floor(lastUpdate / 1000) });
    }
    if (route === "/invocations") {
      if (req.method !== "POST") throw new HttpFailure(405, "método não permitido");
      return invocations(req, res);
    }
    throw new HttpFailure(404, "não encontrado");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const failure = error instanceof HttpFailure ? error : new HttpFailure(500, "erro interno");
      if (!(error instanceof HttpFailure)) log(`erro ao tratar ${req.method} ${req.url}: ${describe(error)}`);
      if (!res.headersSent) sendJson(res, failure.status, { accepted: false, error: failure.message });
    });
  });

  async function idle(): Promise<void> {
    while (current) await current.done;
  }

  async function shutdown(graceSeconds: number): Promise<void> {
    shuttingDown = true;
    const running = current;
    if (running) {
      log(`encerrando: aguardando a tarefa ${running.taskId} por até ${graceSeconds}s`);
      const graceOver = new AbortController();
      const finished = await Promise.race([running.done.then(() => true), defaultSleep(graceSeconds * 1000, graceOver.signal).then(() => false)]);
      graceOver.abort();
      if (!finished) {
        log(`tempo de espera esgotado: cancelando a tarefa ${running.taskId}`);
        running.cancel.abort();
      }
      await idle();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { server, status, currentTaskId: () => current?.taskId ?? null, idle, shutdown };
}

// ---------------------------------------------------------------- main

export interface EntryConfig {
  readonly port: number;
  readonly workDir: string;
  readonly gitToken: string | undefined;
  readonly graceSeconds: number;
  readonly allowedPanelOrigin: string | undefined;
}

function intEnv(raw: string | undefined, name: string, min: number, max: number, fallback: number, errors: string[]): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} precisa ser um inteiro entre ${min} e ${max}`);
    return fallback;
  }
  return value;
}

export function readEntryConfig(env: Readonly<Record<string, string | undefined>>): { ok: true; config: EntryConfig } | { ok: false; errors: readonly string[] } {
  const errors: string[] = [];
  const port = intEnv(env.PORT, "PORT", 1, 65535, DEFAULT_PORT, errors);
  const graceSeconds = intEnv(env.CARBON_WORKER_GRACE_SECONDS, "CARBON_WORKER_GRACE_SECONDS", 0, MAX_GRACE_SECONDS, DEFAULT_GRACE_SECONDS, errors);
  let allowedPanelOrigin: string | undefined;
  const pinned = env.CARBON_PANEL_URL?.trim();
  if (pinned) {
    const check = invocationSchema.shape.panelUrl.safeParse(pinned);
    if (check.success) allowedPanelOrigin = originOf(pinned);
    else errors.push("CARBON_PANEL_URL precisa ser uma URL http(s) válida");
  }
  const workDir = path.resolve(env.CARBON_WORKER_DIR?.trim() || path.join(tmpdir(), "carbon-agentcore"));
  const gitToken = env.CARBON_GIT_TOKEN?.trim() || undefined;
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { port, workDir, gitToken, graceSeconds, allowedPanelOrigin } };
}

const stderrLog = (message: string): void => {
  process.stderr.write(`${new Date().toISOString()} [carbon-agentcore] ${message}\n`);
};

export async function main(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const parsed = readEntryConfig(env);
  if (!parsed.ok) {
    for (const error of parsed.errors) stderrLog(`configuração inválida: ${error}`);
    process.exit(1);
  }
  const { config } = parsed;
  const app = createAgentCoreServer({ workDir: config.workDir, gitToken: config.gitToken, allowedPanelOrigin: config.allowedPanelOrigin, log: stderrLog });
  let signals = 0;
  const onSignal = (name: NodeJS.Signals) => {
    signals += 1;
    if (signals > 1) {
      stderrLog(`${name} de novo: saindo imediatamente`);
      process.exit(130);
    }
    stderrLog(`${name} recebido: recusando novas invocações (até ${config.graceSeconds}s para terminar a atual)`);
    app.shutdown(config.graceSeconds).then(
      () => process.exit(0),
      (error: unknown) => {
        stderrLog(`erro ao encerrar: ${describe(error)}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(config.port, HOST, () => resolve());
  });
  const { port } = app.server.address() as AddressInfo;
  stderrLog(`carbon-agentcore protocolo ${PROTOCOL_VERSION} ouvindo em ${HOST}:${port} · pasta ${config.workDir}`);
}

/** True when this module is the process entry (dist/agentcore.mjs), false when imported (tests). */
function isEntry(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((error: unknown) => {
    stderrLog(`erro fatal: ${describe(error)}`);
    process.exit(1);
  });
}
