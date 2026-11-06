import "server-only";
import type { EventEmitter } from "node:events";
import type { StageId, Ticket } from "@/lib/domain/types";
import type { ExecutorEvent } from "../executors/events";
import { buildCommand, startExecutor, type PermissionDecision, type RunningExecutor } from "../executors/spawn";
import { commentOnIssue } from "../integrations/linear";
import { run } from "../proc";
import { getSettings, type Settings } from "../repo/settings";
import { classifyAction, decide, rulePatternFor } from "../permissions/classify";
import { addRule, findMatchingRule } from "../permissions/rules";
import { skillsForPersona } from "../repo/skills";
import { addLesson, findTask, moveToFront, nextQueuedLocalTask, saveSnapshot, type Task } from "../repo/tasks";
import { executionLabel, resolveModel } from "@/lib/domain/models";
import { readRepoMemory } from "../knowledge/claude-memory";
import { buildKnowledgeContext } from "../knowledge/context";
import { ensureFreshIndex } from "../knowledge/indexer";
import { checkRepo } from "../system/detect";
import { findProject } from "../repo/projects";
import { applyExecutorEvent, canSplit, emptyContext, reconcilePlan, type RunContext } from "./apply";
import { createLiveTicket, liveEvents, notifyLive, type LiveTicket } from "./live";
import { taskPrompt } from "./prepare-claim";
import { answeredQuestions, answerQuestion as applyAnswer, resumeMessage } from "./questions";
import { answerRemotePermission, type PermissionChoice } from "./remote-permissions";
import { leaseHolder } from "./scheduler";
import { cancelSubtasks, createSubtasks, mergeSubtasks, reconcileSplits, withMergeResults } from "./split";
import { distributedPhase, type MergeReportEntry } from "./split-prompt";
import { closeRunningSubagents } from "./subagents";
import { collectDiff, commit, diffBetween, materializeSkills, prepareWorktree, pushAndOpenPr, writeClaudeMemory, writeProjectMap } from "./workspace";
import { releaseWorktree } from "./worktree";

const LESSON_CONFIDENCE = 0.6;

interface PendingPermission {
  readonly taskId: string;
  readonly tool: string;
  readonly repoPath: string;
  readonly input: unknown;
  readonly suggestions: readonly unknown[];
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RunnerState {
  enabled: boolean;
  activeTaskId: string | null;
  executor: RunningExecutor | null;
  tracker: Tracker | null;
  cancelled: boolean;
  /** When the current run started (ms), to add its duration to the ticket on finish. */
  runStartedAt: number | null;
  readonly pending: Map<string, PendingPermission>;
  /** Tasks where a human chose "allow everything for the rest of this task". */
  readonly allowAll: Set<string>;
  readonly events: EventEmitter;
}

const globalForRunner = globalThis as unknown as { carbonRunner?: RunnerState };

function state(): RunnerState {
  if (!globalForRunner.carbonRunner) {
    globalForRunner.carbonRunner = { enabled: true, activeTaskId: null, executor: null, tracker: null, cancelled: false, runStartedAt: null, pending: new Map(), allowAll: new Set(), events: liveEvents() };
  }
  return globalForRunner.carbonRunner;
}

export const runnerEvents = (): EventEmitter => state().events;
export const runnerStatus = () => ({ enabled: state().enabled, activeTaskId: state().activeTaskId });

const notify = notifyLive;

const tracker = (task: Task): LiveTicket => createLiveTicket(task.id, task.snapshot);

type Tracker = LiveTicket;

/** Shows worktree paths as repo-relative paths in logs and research hits. */
function relativize(event: ExecutorEvent, root: string): ExecutorEvent {
  if (event.type !== "tool") return event;
  const strip = (text: string) => text.split(`${root}/`).join("").split(root).join(".");
  return { ...event, summary: strip(event.summary), path: event.path ? strip(event.path) : null };
}

/** Lifecycle events for integrations (Slack, Telegram, Jira). Listeners must not throw. */
export type TaskEventType = "started" | "question" | "done" | "failed";
export interface TaskEvent {
  readonly type: TaskEventType;
  readonly taskId: string;
  readonly detail: string;
}
export const TASK_EVENT = "task";

function emitTask(type: TaskEventType, taskId: string, detail: string) {
  state().events.emit(TASK_EVENT, { type, taskId, detail } satisfies TaskEvent);
}

const EVENT_FOR_STATUS: Partial<Record<Ticket["status"], TaskEventType>> = { waiting: "question", failed: "failed", done: "done" };

/** `notify: false` keeps integrations quiet (a split parent waits for its parts, not for a human). */
function finish(t: Tracker, status: Ticket["status"], stage: StageId, text: string, level: "ok" | "warn", notify = true) {
  const s = state();
  const elapsed = s.runStartedAt ? Math.round((Date.now() - s.runStartedAt) / 1000) : 0;
  s.runStartedAt = null;
  t.log(stage, level, text);
  // A cancelled or timed-out run never reports its sub-agents' end: close them with the task.
  const current = closeRunningSubagents(t.get(), status === "failed" ? "failed" : "done", new Date().toISOString());
  t.set({ ...current, status, stage, runSeconds: (current.runSeconds ?? 0) + elapsed }, true);
  const event = EVENT_FOR_STATUS[status];
  if (event && notify) emitTask(event, t.get().id, text);
}

async function deliver(task: Task, t: Tracker, wt: Awaited<ReturnType<typeof prepareWorktree>>, ctx: RunContext) {
  const settings = getSettings();
  t.log("deliver", "tool", "git add -A · coletando diff");
  const diff = await collectDiff(wt.path);
  t.set({ ...t.get(), diff }, true);
  // An integrated distributed task already holds the merged parts as commits: deliver those too.
  const integrated = t.get().split?.phase === "integrating";
  if (diff.length === 0 && !integrated) return t.log("deliver", "warn", "o agente não alterou arquivos — nada a entregar", true);

  if (diff.length > 0) {
    const committed = await commit(wt.path, `feat: ${task.title} (${task.key})\n\nGenerated by Carbon (${task.executor}).`);
    if (!committed.ok) return t.log("deliver", "warn", `commit falhou: ${committed.detail}`, true);
    const current = t.get();
    if (current.workspace) t.set({ ...current, workspace: { ...current.workspace, commit: committed.sha } });
    t.log("deliver", "ok", `commit ${committed.sha ?? ""} em ${wt.branch}`.replace("  ", " "));
  }
  if (integrated && wt.prBase) {
    const full = await diffBetween(wt.path, wt.base, "HEAD");
    t.set({ ...t.get(), diff: [...full] }, true);
    if (full.length === 0) return t.log("deliver", "warn", "as partes e a integração não alteraram arquivos — nada a entregar", true);
  }
  if (task.snapshot.parent) {
    return t.log("deliver", "info", `parte de ${task.snapshot.parent.key}: fica no branch ${wt.branch}; a tarefa principal integra e abre o PR`, true);
  }

  if (!settings.autoPush) {
    return t.log("deliver", "info", `push desligado. Abra o PR pelo card de entrega (escolha o branch de destino) ou revise: cd ${wt.path} && git log -1 --stat`, true);
  }
  const isDraft = settings.acceptMode === "observe";
  const body = `Tarefa ${task.key} executada por Carbon (${task.executor}).\n\n${t.get().plan.map((s) => `- [${s.done ? "x" : " "}] ${s.text}`).join("\n")}\n\nCusto estimado: ${ctx.costUsd ? `US$ ${ctx.costUsd.toFixed(2)}` : "n/d"}.`;
  const pr = await pushAndOpenPr(wt, `${task.title} (${task.key})`, body, isDraft);
  if (!pr.ok || !pr.url) return t.log("deliver", "warn", pr.detail, true);

  const number = Number(/\/pull\/(\d+)/.exec(pr.url)?.[1] ?? 0);
  t.set({ ...t.get(), pr: { number, branch: wt.branch, draft: isDraft, base: wt.prBase ?? undefined, url: pr.url } });
  t.log("deliver", "ok", `PR ${pr.url}${isDraft ? " (draft · observe)" : ""}`, true);

  if (task.source === "linear" && task.sourceRef && settings.linearApiKey) {
    try {
      await commentOnIssue(settings.linearApiKey, task.sourceRef, `Carbon abriu ${pr.url} para esta issue.`);
      t.log("deliver", "ok", "comentário publicado no Linear");
    } catch (error) {
      t.log("deliver", "warn", `Linear: ${error instanceof Error ? error.message : "falha ao comentar"}`);
    }
  }
}

async function execute(task: Task): Promise<void> {
  const s = state();
  const settings = getSettings();
  const t = tracker(task);
  s.activeTaskId = task.id;
  s.cancelled = false;
  s.runStartedAt = Date.now();
  // Resuming after an answer keeps logs, plan and stage; a fresh run keeps only the decisions already made.
  const resuming = task.snapshot.resume === true;
  const resumeStage: StageId = task.snapshot.stage ?? "plan";
  if (resuming) {
    t.set({ ...t.get(), status: "running", resume: false }, true);
    t.log(resumeStage, "info", task.snapshot.split?.phase === "integrating" ? "retomando para integrar as partes" : "retomando com a sua resposta");
  } else {
    const decided = answeredQuestions(t.get());
    t.set({ ...t.get(), status: "running", stage: "intake", logs: [], plan: [], hits: [], diff: [], findings: [], tests: null, pr: null, questions: decided, sessionId: null, resume: false }, true);
    t.log("intake", "info", `${task.source} ${task.key} · persona ${task.persona} · executor ${task.executor}`);
  }
  emitTask("started", task.id, resuming ? "retomando com a resposta" : "começando");

  try {
    const project = task.projectId ? findProject(task.projectId) : null;
    if (!project) return finish(t, "failed", "intake", "o projeto desta tarefa não existe mais", "warn");
    const repo = checkRepo(project.repoPath);
    if (repo.status !== "ok") return finish(t, "failed", "intake", `repositório inválido: ${repo.detail}`, "warn");
    const bin = await run(task.executor, ["--version"], { timeoutMs: 10_000 });
    if (!bin.ok) return finish(t, "failed", "intake", `${task.executor} não encontrado no PATH`, "warn");

    const wt = await prepareWorktree(project.repoPath, task.snapshot.baseBranch ?? project.baseBranch, task.key, task.id);
    // A resumed run keeps the commit it may already have; a fresh run starts without one.
    const previousCommit = resuming ? (t.get().workspace?.commit ?? null) : null;
    t.set({ ...t.get(), workspace: { path: wt.path, branch: wt.branch, base: wt.base, prBase: wt.prBase, commit: previousCommit, isActive: true } });
    t.log("intake", "tool", `worktree ${wt.branch} ← ${wt.base}`);
    for (const note of wt.notes) t.log("intake", "warn", note);
    const skills = materializeSkills(wt.path, skillsForPersona(task.persona));
    t.log("intake", "ok", `${skills.length} skills instaladas · permissão ${settings.permissionProfile}`);
    const freshness = await ensureFreshIndex({ id: project.id, repoPath: project.repoPath });
    const knowledge = buildKnowledgeContext(project.id, task.title, task.description);
    if (knowledge) {
      writeProjectMap(wt.path, knowledge.mapMarkdown);
      const hits = knowledge.relevant.map((r, i) => ({ id: `${task.id}-k${i}`, kind: "code" as const, ref: r.path, score: r.score, excerpt: r.summary || "do índice do projeto" }));
      t.set({ ...t.get(), hits });
      t.log("intake", "ok", `base de conhecimento ${freshness === "reindexed" ? "atualizada" : "ok"} · ${hits.length} arquivos pré-selecionados`);
    } else {
      t.log("intake", "warn", "projeto ainda não indexado: o agente vai explorar do zero (mais lento)");
    }
    const memory = settings.useClaudeMemory ? readRepoMemory(project.repoPath) : null;
    if (memory) writeClaudeMemory(wt.path, memory);
    if (settings.useClaudeMemory) {
      t.log("intake", memory ? "ok" : "info", memory
        ? `memória do Claude Code: ${memory.files.length} arquivo(s)${memory.isTruncated ? " (cortada no limite)" : ""}`
        : "memória do Claude Code: nenhuma encontrada para este repositório");
    }
    const choice = resolveModel(task.executor, task.model, task.title, task.description, task.effort);
    t.set({ ...t.get(), model: executionLabel(task.executor, choice) });
    t.log("intake", "info", `modelo ${choice.label} — ${choice.reason}`);
    t.set({ ...t.get(), stage: resuming ? resumeStage : "plan", repo: project.name }, true);

    const decisions = answeredQuestions(t.get());
    // Integration run of a distributed task: bring the parts in before the agent starts.
    const integrating = distributedPhase(t.get()) === "integrate";
    let mergeReport: readonly MergeReportEntry[] = [];
    const split = t.get().split;
    if (integrating && split) {
      mergeReport = await mergeSubtasks(wt.path, split);
      t.set({ ...t.get(), split: withMergeResults(split, mergeReport) }, true);
      for (const entry of mergeReport) {
        const text = { merged: "integrada (merge limpo)", empty: "sem mudanças", conflict: "conflito: o agente aplica o patch à mão", failed: "falhou: o agente faz esta parte" }[entry.result];
        t.log("intake", entry.result === "merged" || entry.result === "empty" ? "ok" : "warn", `parte ${entry.key} · ${entry.title}: ${text}`);
      }
    }
    const fullPrompt = () =>
      taskPrompt({ ...task, snapshot: t.get() }, project.id, { skills, knowledge: knowledge?.prompt ?? null, memory, decisions, mergeReport });
    const runAgent = async (prompt: string, resumeSessionId: string | null) => {
      let ctx = emptyContext;
      const command = buildCommand(task.executor, prompt, wt.path, settings, choice, resumeSessionId);
      s.tracker = t;
      s.executor = startExecutor(command, wt.path, settings.maxRunMinutes * 60_000, (event) => {
        // Most permission prompts are answered here, without a human: policy, repo rules, task-wide allow.
        if (event.type === "permission_request" && autoAnswer(task.id, event, wt.path, project.repoPath, settings, t)) return;
        const next = applyExecutorEvent(t.get(), ctx, relativize(event, wt.path));
        ctx = next.ctx;
        t.set(next.ticket, event.type === "permission_request");
        if (event.type === "permission_request") registerPending(task.id, event.tool, project.repoPath, event.requestId, event.input, event.suggestions, settings.permissionTimeoutMinutes);
      });
      const exit = await s.executor.done;
      expirePending(task.id);
      s.executor = null;
      return { exit, ctx };
    };

    // Claude Code continues the same session (keeps everything it read and decided); Codex starts
    // fresh with the decisions in the prompt. A resume that cannot find its session falls back to fresh.
    const resumeId = resuming && !integrating && task.executor === "claude" ? (task.snapshot.sessionId ?? null) : null;
    let { exit, ctx } = await runAgent(resumeId ? resumeMessage(decisions) : fullPrompt(), resumeId);
    if (resumeId && !s.cancelled && !exit.timedOut && exit.code !== 0 && ctx.sessionId === null) {
      t.log(t.get().stage ?? resumeStage, "warn", "sessão anterior indisponível: recomeçando o agente com as suas decisões no contexto", true);
      ({ exit, ctx } = await runAgent(fullPrompt(), null));
    }

    if (s.cancelled) return finish(t, "failed", t.get().stage ?? "code", "cancelado por você", "warn");
    if (exit.timedOut) return finish(t, "failed", t.get().stage ?? "code", `tempo limite (${settings.maxRunMinutes} min) atingido`, "warn");
    if (ctx.question) return finish(t, "waiting", t.get().stage ?? "plan", "aguardando sua resposta no card de pergunta (acima do pipeline) para continuar", "warn");
    if (exit.code !== 0 || ctx.isError) {
      return finish(t, "failed", t.get().stage ?? "code", `agente saiu com código ${exit.code}: ${exit.stderrTail.split("\n").filter(Boolean).at(-1) ?? ""}`, "warn");
    }

    // Distributed task: the agent declared parts and stopped. Commit its groundwork and fan out.
    if (ctx.subtasks.length > 0 && canSplit(t.get())) {
      await run("git", ["add", "-A"], { cwd: wt.path, timeoutMs: 60_000 });
      const groundwork = await commit(wt.path, `chore: base para as partes de ${task.key} (Carbon)`);
      if (groundwork.ok && groundwork.sha) t.log(t.get().stage ?? "code", "ok", `base compartilhada commitada (${groundwork.sha}) em ${wt.branch}`);
      t.set(createSubtasks(task, t.get(), wt.branch, ctx.subtasks), true);
      return finish(t, "waiting", t.get().stage ?? "code", "aguardando as partes rodarem nos computadores do cluster; depois a tarefa integra e entrega", "ok", false);
    }

    const reconciled = reconcilePlan(t.get());
    t.set({ ...reconciled.ticket, stage: "deliver" }, true);
    if (reconciled.unconfirmed > 0) {
      t.log("deliver", "warn", `${reconciled.unconfirmed} passo(s) do plano sem confirmação do agente — revise antes de aprovar`, true);
    }
    await deliver(task, t, wt, ctx);

    t.set({ ...t.get(), stage: "reflect" }, true);
    for (const lesson of ctx.lessons) {
      addLesson(project.id, { ticketKey: task.key, rule: lesson.rule, evidence: lesson.evidence, scope: project.name, confidence: LESSON_CONFIDENCE });
    }
    t.log("reflect", "ok", `${ctx.lessons.length} lição(ões) candidata(s) para revisão`);
    const finishedSplit = t.get().split;
    if (finishedSplit?.phase === "integrating") t.set({ ...t.get(), split: { ...finishedSplit, phase: "done" } });
    finish(t, "done", "reflect", "ticket concluído", "ok");
  } catch (error) {
    finish(t, "failed", t.get().stage ?? "intake", error instanceof Error ? error.message : "falha inesperada", "warn");
  } finally {
    s.allowAll.delete(task.id);
    expirePending(task.id);
    s.executor = null;
    s.tracker = null;
    await releaseFinishedWorktree(task, t);
    s.activeTaskId = null;
    notify();
  }
}

/**
 * The worktree only lives while the agent works or waits for an answer. Once the task is done
 * (or failed) with everything committed, the folder goes away and the branch stays in the repo.
 */
async function releaseFinishedWorktree(task: Task, t: Tracker): Promise<void> {
  const ticket = t.get();
  const workspace = ticket.workspace;
  if ((ticket.status !== "done" && ticket.status !== "failed") || !workspace?.path || workspace.isActive === false) return;
  const project = task.projectId ? findProject(task.projectId) : null;
  if (!project) return;
  try {
    const result = await releaseWorktree(project.repoPath, workspace.path);
    if (result === "removed" || result === "missing") {
      t.set({ ...t.get(), workspace: { ...workspace, isActive: false } });
      t.log(ticket.stage ?? "reflect", "info", `worktree removido; as mudanças ficam no branch ${workspace.branch}`, true);
    } else if (result === "dirty") {
      t.log(ticket.stage ?? "reflect", "warn", `worktree mantido: há mudanças não commitadas em ${workspace.path}`, true);
    }
  } catch (error) {
    console.error("[carbon] liberar worktree:", error instanceof Error ? error.message : String(error));
  }
}

type PermissionRequestEvent = Extract<ExecutorEvent, { type: "permission_request" }>;

/** Adds an already-decided prompt to the ticket history (no card, no waiting). */
function recordDecided(t: Tracker, event: PermissionRequestEvent, status: "allowed" | "denied", decidedBy: string) {
  const current = t.get();
  const prompt = {
    id: event.requestId,
    tool: event.tool,
    summary: event.summary,
    detail: event.detail,
    canRemember: false,
    status,
    decidedBy,
    askedAt: new Date().toISOString(),
    auto: true,
  };
  t.set({ ...current, permissions: [...(current.permissions ?? []), prompt].slice(-200) });
}

/** Returns true when the prompt was answered automatically (and must not reach the panel). */
function autoAnswer(taskId: string, event: PermissionRequestEvent, worktree: string, repoPath: string, settings: Settings, t: Tracker): boolean {
  const s = state();
  if (!s.executor) return false;
  const classification = classifyAction(event.tool, event.input, worktree);
  const verdict = decide(settings.approvalPolicy, classification);
  const stage = t.get().stage ?? "code";
  if (verdict === "block") {
    s.executor.respond(event.requestId, { behavior: "deny", message: `Bloqueado pela política do Carbon (${classification.reason}). Não tente contornar; siga sem essa ação ou pare e explique.` });
    recordDecided(t, event, "denied", `bloqueio: ${classification.reason}`);
    t.log(stage, "warn", `bloqueado: ${event.tool} — ${classification.reason}`);
    return true;
  }
  const rule = findMatchingRule(repoPath, event.tool, event.input);
  const by = s.allowAll.has(taskId) ? "tudo liberado nesta tarefa" : rule ? `regra: ${rule.tool} ${rule.pattern}`.trim() : verdict === "safe" ? `auto: ${classification.reason}` : null;
  if (!by) return false;
  s.executor.respond(event.requestId, { behavior: "allow", input: event.input, remember: [] });
  recordDecided(t, event, "allowed", by);
  return true;
}

function setPromptStatus(t: Tracker, requestId: string, status: "allowed" | "denied" | "expired", decidedBy: string | null) {
  const current = t.get();
  const permissions = (current.permissions ?? []).map((p) => (p.id === requestId ? { ...p, status, decidedBy } : p));
  const stillPending = permissions.some((p) => p.status === "pending");
  t.set({ ...current, permissions, status: stillPending ? "waiting" : current.status === "waiting" ? "running" : current.status }, true);
}

function registerPending(taskId: string, tool: string, repoPath: string, requestId: string, input: unknown, suggestions: readonly unknown[], timeoutMinutes: number) {
  const s = state();
  const timer = setTimeout(() => {
    if (!s.pending.has(requestId)) return;
    s.pending.delete(requestId);
    s.executor?.respond(requestId, { behavior: "deny", message: `Sem resposta em ${timeoutMinutes} min no painel do Carbon; siga sem essa ação ou pare e explique.` });
    if (s.tracker) {
      setPromptStatus(s.tracker, requestId, "expired", null);
      s.tracker.log(s.tracker.get().stage ?? "code", "warn", `permissão expirou após ${timeoutMinutes} min sem resposta`, true);
    }
  }, timeoutMinutes * 60_000);
  timer.unref();
  s.pending.set(requestId, { taskId, tool, repoPath, input, suggestions, timer });
}

function expirePending(taskId: string) {
  const s = state();
  for (const [id, p] of s.pending) {
    if (p.taskId !== taskId) continue;
    clearTimeout(p.timer);
    s.pending.delete(id);
    if (s.tracker) setPromptStatus(s.tracker, id, "expired", null);
  }
}

/**
 * Human decision from the panel for a pending Claude Code permission prompt. Prompts of remote
 * tasks (pool workers, AgentCore) go through the same call: the answer is stored for the worker's
 * long-poll instead of being written to a local process.
 */
export function answerPermission(taskId: string, requestId: string, choice: PermissionChoice, userName: string): { ok: boolean; error?: string } {
  const remote = findTask(taskId);
  if (remote && remote.runtime !== "local") {
    const result = answerRemotePermission(taskId, requestId, choice, userName, getSettings().permissionTimeoutMinutes);
    if (result.ok) notify();
    return result;
  }
  const s = state();
  const pending = s.pending.get(requestId);
  if (!pending || pending.taskId !== taskId || s.activeTaskId !== taskId || !s.executor || !s.tracker) {
    return { ok: false, error: "esse pedido não está mais pendente" };
  }
  const decision: PermissionDecision =
    choice === "deny"
      ? { behavior: "deny", message: `${userName} negou esta ação no painel. Não tente contorná-la; siga sem ela ou pare e explique.` }
      : { behavior: "allow", input: pending.input, remember: [] };
  if (choice === "allow_task") s.allowAll.add(taskId);
  const pattern = choice === "allow_always" ? rulePatternFor(pending.tool, pending.input) : "";
  if (choice === "allow_always") addRule(pending.repoPath, pending.tool, pattern, userName);
  if (!s.executor.respond(requestId, decision)) return { ok: false, error: "o agente já encerrou" };
  clearTimeout(pending.timer);
  s.pending.delete(requestId);
  setPromptStatus(s.tracker, requestId, choice === "deny" ? "denied" : "allowed", userName);
  s.tracker.log(
    s.tracker.get().stage ?? "code",
    choice === "deny" ? "warn" : "ok",
    `${userName} ${choice === "deny" ? "negou" : choice === "allow_always" ? `permitiu sempre neste repositório (${pending.tool} ${pattern})`.trim() : choice === "allow_task" ? "liberou tudo no resto desta tarefa" : "permitiu"} a ação`,
    true,
  );
  return { ok: true };
}

/** Picks the next queued local task if the runner is idle and enabled. Safe to call often. */
export function kick(): void {
  const s = state();
  if (!s.enabled || s.activeTaskId) return;
  const task = nextQueuedLocalTask();
  if (!task) return;
  s.activeTaskId = task.id;
  void execute(task).finally(() => setImmediate(() => {
    reconcileSplits();
    kick();
  }));
}

export function setEnabled(enabled: boolean): void {
  state().enabled = enabled;
  notify();
  if (enabled) kick();
}

/** Server is shutting down: stop the running agent so it never keeps working (and spending) orphaned. */
export function shutdownRunner(): void {
  const s = state();
  s.enabled = false;
  s.cancelled = true;
  s.executor?.cancel();
}

export function cancelActive(): boolean {
  const s = state();
  if (!s.executor) return false;
  s.cancelled = true;
  s.executor.cancel();
  return true;
}

export function retryTask(id: string): boolean {
  const task = findTask(id);
  if (!task || task.status === "running" || task.status === "queued") return false;
  // A retry starts over, but answers already given stay as decisions in the new prompt.
  // A distributed task drops its split: unfinished parts stop and the agent may split again.
  cancelSubtasks(task);
  saveSnapshot(id, { ...task.snapshot, status: "queued", stage: null, resume: false, subagents: [], split: undefined });
  notify();
  kick();
  return true;
}

/** Human answer to a CARBON_QUESTION. When nothing else is pending, the task resumes first in line. */
export function answerTaskQuestion(taskId: string, questionId: string, answer: string, userName: string): { ok: boolean; error?: string } {
  const task = findTask(taskId);
  if (!task) return { ok: false, error: "tarefa não encontrada" };
  if (state().activeTaskId === taskId) return { ok: false, error: "esta tarefa já está executando" };
  // A remote task still leased is running on a worker (e.g. waiting for a permission), not parked on the question.
  if (task.runtime !== "local" && leaseHolder(taskId) !== null) return { ok: false, error: "esta tarefa já está executando" };
  const result = applyAnswer(task.snapshot, questionId, answer, userName, new Date().toISOString());
  if (!result.ok) return { ok: false, error: result.error };
  saveSnapshot(taskId, result.ticket);
  if (result.resumes) moveToFront(taskId);
  notify();
  if (result.resumes) kick();
  return { ok: true };
}

export const notifyChange = notify;
