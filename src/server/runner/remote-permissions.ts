import "server-only";
import type { PermissionPrompt, Ticket } from "@/lib/domain/types";
import type { PermissionDecisionWire, RemotePermissionRule } from "@/shared/worker-protocol";
import type { ExecutorEvent } from "../executors/events";
import { getDb, nowIso } from "../db";
import { rulePatternFor } from "../permissions/classify";
import { addRule } from "../permissions/rules";
import { findProject } from "../repo/projects";
import { findTask } from "../repo/tasks";
import { appendLog } from "./apply";

/**
 * Permission prompts of remote tasks (RMT-01). The worker forwards a prompt that needs a human as
 * a `permission_request` event; the panel shows it exactly like a local one (ticket.permissions)
 * and keeps what it needs to answer it in the snapshot itself, so a panel restart loses nothing:
 *
 * - `pending`: open prompts (tool, the "always allow" pattern, when it was asked);
 * - `decisions`: answers the worker has not necessarily read yet (it long-polls with ?after=seq);
 * - `allowAll`: a human chose "allow everything for the rest of this task".
 *
 * The prompt's raw input never reaches the snapshot: the worker keeps it and answers with it.
 * Everything here is synchronous between read and write, so it never interleaves with event
 * ingestion of the same task inside this process.
 */

export type PermissionChoice = "allow" | "allow_always" | "allow_task" | "deny";

interface RemotePending {
  readonly requestId: string;
  readonly tool: string;
  /** rulePatternFor(tool, input), computed when the prompt arrived. */
  readonly pattern: string;
  /** epoch ms */
  readonly askedAt: number;
}

export interface RemotePermissionState {
  readonly seq: number;
  readonly allowAll: boolean;
  readonly pending: readonly RemotePending[];
  readonly decisions: readonly PermissionDecisionWire[];
}

/** Ticket JSON plus the remote-permission bookkeeping (extra key, kept by every spread/JSON round trip). */
type WithRemote = Ticket & { readonly remotePermissions?: RemotePermissionState };

/** Answers kept for the worker to read; older ones were read long ago (it polls continuously). */
const KEPT_DECISIONS = 100;
const EMPTY: RemotePermissionState = { seq: 0, allowAll: false, pending: [], decisions: [] };

export const remoteState = (ticket: Ticket): RemotePermissionState => (ticket as WithRemote).remotePermissions ?? EMPTY;

const withState = (ticket: Ticket, next: RemotePermissionState): Ticket => ({ ...ticket, remotePermissions: next }) as WithRemote;

/** A new run (claim) starts without the previous run's prompts, answers and "allow all". */
export function clearRemotePermissions(ticket: Ticket): Ticket {
  if (!(ticket as WithRemote).remotePermissions) return ticket;
  const rest = { ...(ticket as WithRemote) };
  delete (rest as { remotePermissions?: unknown }).remotePermissions;
  return rest;
}

const stageOf = (ticket: Ticket) => ticket.stage ?? "code";

/** Same rule as the local runner: the ticket waits while any prompt is pending. */
function withPromptStatus(ticket: Ticket, requestId: string, status: PermissionPrompt["status"], decidedBy: string | null): Ticket {
  const permissions = (ticket.permissions ?? []).map((p) => (p.id === requestId ? { ...p, status, decidedBy } : p));
  const stillPending = permissions.some((p) => p.status === "pending");
  return { ...ticket, permissions, status: stillPending ? "waiting" : ticket.status === "waiting" ? "running" : ticket.status };
}

interface Decide {
  readonly requestId: string;
  readonly behavior: "allow" | "deny";
  readonly message: string | null;
  readonly allowTask: boolean;
  readonly rule: RemotePermissionRule | null;
  readonly promptStatus: PermissionPrompt["status"];
  readonly decidedBy: string | null;
}

/** Closes one pending prompt and queues the answer for the worker. */
function decide(ticket: Ticket, d: Decide): Ticket {
  const state = remoteState(ticket);
  const seq = state.seq + 1;
  const decision: PermissionDecisionWire = { seq, requestId: d.requestId, behavior: d.behavior, message: d.message, allowTask: d.allowTask, rule: d.rule };
  const next: RemotePermissionState = {
    seq,
    allowAll: state.allowAll || d.allowTask,
    pending: state.pending.filter((p) => p.requestId !== d.requestId),
    decisions: [...state.decisions, decision].slice(-KEPT_DECISIONS),
  };
  return withState(withPromptStatus(ticket, d.requestId, d.promptStatus, d.decidedBy), next);
}

type PermissionRequestEvent = Extract<ExecutorEvent, { type: "permission_request" }>;

/**
 * Called for each forwarded prompt after applyExecutorEvent added it to ticket.permissions. With
 * "allow all" already chosen (the worker had not heard yet), it is answered on the spot.
 */
export function registerRemotePrompt(ticket: Ticket, event: PermissionRequestEvent, now: number): Ticket {
  const state = remoteState(ticket);
  if (state.pending.some((p) => p.requestId === event.requestId) || state.decisions.some((d) => d.requestId === event.requestId)) return ticket;
  if (state.allowAll) {
    return decide(ticket, { requestId: event.requestId, behavior: "allow", message: null, allowTask: true, rule: null, promptStatus: "allowed", decidedBy: "tudo liberado nesta tarefa" });
  }
  const pending: RemotePending = { requestId: event.requestId, tool: event.tool, pattern: rulePatternFor(event.tool, event.input), askedAt: now };
  return withState(ticket, { ...state, pending: [...state.pending, pending] });
}

/** Denies every prompt older than the timeout (same text and log as the local runner). */
export function expireOverdue(ticket: Ticket, timeoutMinutes: number, now: number): Ticket {
  const overdue = remoteState(ticket).pending.filter((p) => now - p.askedAt >= timeoutMinutes * 60_000);
  return overdue.reduce((t, p) => {
    const decided = decide(t, {
      requestId: p.requestId,
      behavior: "deny",
      message: `Sem resposta em ${timeoutMinutes} min no painel do Carbon; siga sem essa ação ou pare e explique.`,
      allowTask: false,
      rule: null,
      promptStatus: "expired",
      decidedBy: null,
    });
    return appendLog(decided, stageOf(decided), "warn", `permissão expirou após ${timeoutMinutes} min sem resposta`);
  }, ticket);
}

/** The run ended (result, cancel, lease lost): open prompts are closed as expired, nothing is answered. */
export function closeRemotePrompts(ticket: Ticket): Ticket {
  const state = remoteState(ticket);
  if (state.pending.length === 0) return ticket;
  const closed = state.pending.reduce((t, p) => withPromptStatus(t, p.requestId, "expired", null), ticket);
  return withState(closed, { ...state, pending: [] });
}

export const decisionsAfter = (ticket: Ticket, after: number): readonly PermissionDecisionWire[] =>
  remoteState(ticket).decisions.filter((d) => d.seq > after);

// ---------------------------------------------------------------- DB side

interface Row {
  readonly snapshot: string;
  readonly runtime: string;
  readonly status: string;
  readonly lease_worker: string | null;
  readonly lease_expires_at: number | null;
}

const readRow = (taskId: string): Row | undefined =>
  getDb().prepare("SELECT snapshot, runtime, status, lease_worker, lease_expires_at FROM tasks WHERE id = ?").get(taskId) as Row | undefined;

/** Writes the snapshot only while the same worker still holds the lease (a sweep or result in between wins). */
function writeLeased(taskId: string, row: Row, ticket: Ticket): boolean {
  const result = getDb()
    .prepare("UPDATE tasks SET snapshot = ?, status = ?, updated_at = ? WHERE id = ? AND lease_worker IS ? AND status IN ('running', 'waiting')")
    .run(JSON.stringify(ticket), ticket.status, nowIso(), taskId, row.lease_worker);
  return Number(result.changes) > 0;
}

const liveLease = (row: Row, now: number) =>
  row.runtime !== "local" && row.lease_worker !== null && row.lease_expires_at !== null && row.lease_expires_at >= now && (row.status === "running" || row.status === "waiting");

export type PollResult = { readonly decisions: readonly PermissionDecisionWire[]; readonly changed: boolean } | "lease_lost";

/**
 * One check of the worker's long-poll: expires overdue prompts (persisted, so a restart keeps the
 * clock) and returns the answers after `after`. "lease_lost" when `workerId` no longer owns the task.
 */
export function pollRemoteDecisions(taskId: string, workerId: string, after: number, timeoutMinutes: number, now = Date.now()): PollResult {
  const row = readRow(taskId);
  if (!row || row.lease_worker !== workerId || !liveLease(row, now)) return "lease_lost";
  const ticket = JSON.parse(row.snapshot) as Ticket;
  const expired = expireOverdue(ticket, timeoutMinutes, now);
  const changed = expired !== ticket;
  if (changed && !writeLeased(taskId, row, expired)) return "lease_lost";
  return { decisions: decisionsAfter(expired, after), changed };
}

export type AnswerResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

const NOT_PENDING = "esse pedido não está mais pendente";

/**
 * First words of Bash patterns never stored as "always allow" for a remote prompt: shells,
 * interpreters, network tools and wrappers run arbitrary code, so a persistent rule for them is a
 * standing "run anything" in the repo (also for local runs). The answer is downgraded to "allow once".
 */
const UNSAFE_BASH_RULE =
  /^(ba|z|da|k|c|tc|fi)?sh$|^python[\d.]*$|^(py|node|nodejs|deno|bun|perl|ruby|php|lua|osascript|curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|rsync|eval|exec|source|\.|sudo|su|doas|env|xargs|nohup|timeout|time|nice|command|builtin)$/;

/** True when an "always allow" rule for this prompt would be too broad to keep. */
export function isUnsafeAlwaysRule(tool: string, pattern: string): boolean {
  if (tool !== "Bash") return false;
  const first = pattern.trim().split(/\s+/)[0] ?? "";
  // An empty Bash pattern matches every command.
  return first === "" || UNSAFE_BASH_RULE.test(first.replace(/^.*\//, ""));
}

function choiceLog(userName: string, choice: PermissionChoice, tool: string, pattern: string): string {
  const what =
    choice === "deny" ? "negou" : choice === "allow_always" ? `permitiu sempre neste repositório (${tool} ${pattern})`.trim() : choice === "allow_task" ? "liberou tudo no resto desta tarefa" : "permitiu";
  return `${userName} ${what} a ação`;
}

/**
 * Human answer from the panel for a prompt a worker forwarded. Same choices and texts as the
 * local runner; the worker picks the answer up on its long-poll and answers the agent.
 */
export function answerRemotePermission(taskId: string, requestId: string, requested: PermissionChoice, userName: string, timeoutMinutes: number, now = Date.now()): AnswerResult {
  const row = readRow(taskId);
  if (!row || !liveLease(row, now)) return { ok: false, error: NOT_PENDING };
  const current = JSON.parse(row.snapshot) as Ticket;
  // An answer after the timeout is too late: the prompt expires instead (the agent already moved on).
  const ticket = expireOverdue(current, timeoutMinutes, now);
  const pending = remoteState(ticket).pending.find((p) => p.requestId === requestId);
  if (!pending) {
    if (ticket !== current) writeLeased(taskId, row, ticket);
    return { ok: false, error: NOT_PENDING };
  }
  const task = findTask(taskId);
  const project = task?.projectId ? findProject(task.projectId) : null;
  const worker = row.lease_worker ?? "?";
  const downgraded = requested === "allow_always" && isUnsafeAlwaysRule(pending.tool, pending.pattern);
  const choice: PermissionChoice = downgraded ? "allow" : requested;
  if (choice === "allow_always") {
    if (!project) return { ok: false, error: "o projeto desta tarefa não existe mais" };
    addRule(project.repoPath, pending.tool, pending.pattern, `${userName} (pedido do worker ${worker})`);
  }
  const decided = decide(ticket, {
    requestId,
    behavior: choice === "deny" ? "deny" : "allow",
    message: choice === "deny" ? `${userName} negou esta ação no painel. Não tente contorná-la; siga sem ela ou pare e explique.` : null,
    allowTask: choice === "allow_task",
    rule: choice === "allow_always" ? { tool: pending.tool, pattern: pending.pattern } : null,
    promptStatus: choice === "deny" ? "denied" : "allowed",
    decidedBy: userName,
  });
  const answered = appendLog(decided, stageOf(decided), choice === "deny" ? "warn" : "ok", `${choiceLog(userName, choice, pending.tool, pending.pattern)} (worker ${worker})`);
  const logged = downgraded
    ? appendLog(answered, stageOf(answered), "warn", `"permitir sempre" recusado para ${pending.tool} "${pending.pattern || "qualquer comando"}" (shell/interpretador/rede): permitido só desta vez`)
    : answered;
  if (!writeLeased(taskId, row, logged)) return { ok: false, error: NOT_PENDING };
  if (downgraded) console.warn(`[carbon] permitir sempre recusado para ${pending.tool} "${pending.pattern}" na tarefa ${taskId} (worker ${worker}): permitido uma vez`);
  return { ok: true };
}
