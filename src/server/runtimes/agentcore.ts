import "server-only";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand, StopRuntimeSessionCommand } from "@aws-sdk/client-bedrock-agentcore";
import { issueTaskToken, revokeTaskTokens } from "../auth/worker-auth";
import { getSettings, type Settings } from "../repo/settings";
import { notifyLive } from "../runner/live";
import { countActiveSessions, failUnclaimed, markDispatched, queuedAgentCoreTasks, runningAgentCoreTasks, taskStatus } from "./agentcore-store";
import { agentcoreAvailability } from "./availability";
import { agentcoreSessionId } from "./session";

/**
 * AgentCore dispatcher (panel side). Every DISPATCH_INTERVAL_MS it:
 * 1. stops the sessions of tracked tasks that are no longer running (done/failed/canceled/…);
 * 2. while active sessions < maxConcurrent, invokes the runtime for the oldest queued AgentCore
 *    task with a one-time task token. The container then talks to the panel over the worker
 *    protocol; the Invoke response stream is never read.
 * The AWS client is injected (`send`) so tests never touch the network or need credentials.
 */

export type AgentCoreCommand = InvokeAgentRuntimeCommand | StopRuntimeSessionCommand;
export type AgentCoreSend = (command: AgentCoreCommand, region: string) => Promise<unknown>;

export const DISPATCH_INTERVAL_MS = 5_000;
/** AgentCore Runtime session maxLifetime; also the task token TTL. */
export const MAX_SESSION_LIFETIME_MS = 8 * 60 * 60_000;
/** Invoke is retried this many times after the first failure. */
export const INVOKE_RETRIES = 3;
export const RETRY_BASE_MS = 1_000;
const ERROR_MAX = 300;

export interface DispatcherDeps {
  readonly send: AgentCoreSend;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly settings?: () => Settings;
  readonly hasCredentials?: () => boolean;
}

export interface AgentCoreDispatcher {
  /** One pass: stop finished sessions, then dispatch queued tasks up to the cap. */
  tick(): Promise<void>;
  /** Task ids whose session may still be alive (Stop pending on finish). */
  tracked(): readonly string[];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** SDK error → short text for the task log: name, HTTP status, message; tokens and keys redacted. */
export function summarizeSdkError(error: unknown): string {
  const err = error as { name?: unknown; message?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  const name = typeof err?.name === "string" ? err.name : "Error";
  const status = typeof err?.$metadata?.httpStatusCode === "number" ? ` (HTTP ${err.$metadata.httpStatusCode})` : "";
  const message = typeof err?.message === "string" ? err.message : String(error);
  const redacted = message
    .replace(/\b(ctk|cwk)_[A-Za-z0-9_-]+/g, "$1_***")
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{12,}/g, "$1***")
    .replace(/\s+/g, " ")
    .trim();
  const text = `${name}${status}: ${redacted}`;
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text;
}

/** Closes the unread response stream so the HTTP connection is not kept open. */
function releaseStream(output: unknown): void {
  const stream = (output as { response?: { destroy?: () => void } } | null)?.response;
  if (stream && typeof stream.destroy === "function") stream.destroy();
}

function invokePayload(taskId: string, panelUrl: string, taskToken: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ taskId, panelUrl, taskToken }));
}

export function createAgentCoreDispatcher(deps: DispatcherDeps): AgentCoreDispatcher {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const readSettings = deps.settings ?? getSettings;
  // Seeded with tasks already running (panel restart) so their sessions are stopped when they end.
  let sessions: ReadonlySet<string> = new Set(runningAgentCoreTasks());
  let busy = false;

  async function stopSession(taskId: string, settings: Settings): Promise<void> {
    revokeTaskTokens(taskId);
    if (!settings.agentcore.runtimeArn) return;
    try {
      const command = new StopRuntimeSessionCommand({
        agentRuntimeArn: settings.agentcore.runtimeArn,
        qualifier: settings.agentcore.qualifier || undefined,
        runtimeSessionId: agentcoreSessionId(taskId),
      });
      await deps.send(command, settings.agentcore.region);
    } catch (error) {
      // Best effort: an unstopped session still ends on its idle timeout (15 min).
      console.warn(`[carbon] AgentCore: não foi possível encerrar a sessão de ${taskId}: ${summarizeSdkError(error)}`);
    }
  }

  async function stopFinished(settings: Settings): Promise<void> {
    const finished = [...sessions].filter((id) => taskStatus(id) !== "running");
    if (finished.length === 0) return;
    sessions = new Set([...sessions].filter((id) => !finished.includes(id)));
    for (const id of finished) await stopSession(id, settings);
  }

  async function invokeWithRetry(command: InvokeAgentRuntimeCommand, region: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= INVOKE_RETRIES; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      try {
        releaseStream(await deps.send(command, region));
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async function dispatch(taskId: string, settings: Settings): Promise<void> {
    const sessionId = agentcoreSessionId(taskId);
    if (!markDispatched(taskId, sessionId, now())) return;
    sessions = new Set([...sessions, taskId]);
    notifyLive();
    const taskToken = issueTaskToken(taskId, MAX_SESSION_LIFETIME_MS, now());
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: settings.agentcore.runtimeArn,
      qualifier: settings.agentcore.qualifier || undefined,
      runtimeSessionId: sessionId,
      contentType: "application/json",
      accept: "application/json",
      payload: invokePayload(taskId, settings.panelPublicUrl, taskToken),
    });
    try {
      await invokeWithRetry(command, settings.agentcore.region);
    } catch (error) {
      revokeTaskTokens(taskId);
      sessions = new Set([...sessions].filter((id) => id !== taskId));
      const tries = INVOKE_RETRIES + 1;
      if (failUnclaimed(taskId, `AgentCore: falha ao invocar o runtime após ${tries} tentativas — ${summarizeSdkError(error)}`)) notifyLive();
    }
  }

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const settings = readSettings();
      await stopFinished(settings);
      if (!agentcoreAvailability(settings, deps.hasCredentials).available) return;
      const slots = settings.agentcore.maxConcurrent - countActiveSessions();
      for (const taskId of queuedAgentCoreTasks(slots)) await dispatch(taskId, settings);
    } finally {
      busy = false;
    }
  }

  return { tick, tracked: () => [...sessions] };
}

// ---------------------------------------------------------------- real client (panel process)

let client: { readonly region: string; readonly instance: BedrockAgentCoreClient } | null = null;

/** Lazily built SDK client (default credential chain of the panel host); rebuilt when the region changes. */
const sdkSend: AgentCoreSend = (command, region) => {
  if (!client || client.region !== region) client = { region, instance: new BedrockAgentCoreClient({ region }) };
  const sdk = client.instance;
  return command instanceof InvokeAgentRuntimeCommand ? sdk.send(command) : sdk.send(command);
};

/** Started once from instrumentation; ticks every DISPATCH_INTERVAL_MS. */
export function startAgentCoreDispatcher(): void {
  const holder = globalThis as unknown as { carbonAgentCoreDispatcher?: ReturnType<typeof setInterval> };
  if (holder.carbonAgentCoreDispatcher) return;
  const dispatcher = createAgentCoreDispatcher({ send: sdkSend });
  const timer = setInterval(() => {
    dispatcher.tick().catch((error: unknown) => console.error("[carbon] dispatcher AgentCore:", error instanceof Error ? error.message : String(error)));
  }, DISPATCH_INTERVAL_MS);
  timer.unref();
  holder.carbonAgentCoreDispatcher = timer;
}
