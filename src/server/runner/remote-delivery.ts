import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { StageId, Ticket, TicketWorkspace } from "@/lib/domain/types";
import { NO_COMMITS_REF, type ResultRequest } from "@/shared/worker-protocol";
import { dataDir, getDb } from "../db";
import { commentOnIssue } from "../integrations/linear";
import { firstLine, run } from "../proc";
import { findProject, type Project } from "../repo/projects";
import { getSettings } from "../repo/settings";
import { addLesson, findTask, type Task } from "../repo/tasks";
import { reconcilePlan } from "./apply";
import { createLiveTicket, liveEvents, remoteRunContext, resetRemoteContext, type LiveTicket } from "./live";
import { baseCommitOf } from "./local-delivery";
import { taskBranch } from "./prepare-claim";
import { pendingQuestions } from "./questions";
import { closeRemotePrompts } from "./remote-permissions";
import { TASK_EVENT, type TaskEvent } from "./runner";
import { releaseLease } from "./scheduler";
import { diffBetween, prepareWorktree, pushAndOpenPr } from "./workspace";
import { releaseWorktree } from "./worktree";

/**
 * Panel side of the code transport for remote tasks (CODE-02/CODE-03): serves the base as a git
 * bundle, receives the worker's result bundle, imports the task branch into the project repo and
 * then runs the same delivery as a local task (diff, push + PR when enabled, lessons, events).
 */

const LESSON_CONFIDENCE = 0.6;
const BUNDLE_TIMEOUT_MS = 300_000;
/** Importing a worker's result: shorter than bundle creation, the result is incremental. */
const IMPORT_TIMEOUT_MS = 120_000;
/**
 * Objects from a worker are untrusted: fsck every object received (rejects malformed objects and
 * trees with `.git` / `..` entries, which could become hooks or config on checkout) and never run
 * hooks or fsmonitor commands of the panel repo during the import.
 */
const IMPORT_CONFIG = ["-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never"];
/** Bundle ref used when the base label is not a valid branch name ("(sem commits)", "HEAD"). */
export const FALLBACK_BASE_BRANCH = "carbon-base";
const MB = 1024 * 1024;

const git = (cwd: string, args: readonly string[], timeoutMs = 60_000) => run("git", args, { cwd, timeoutMs });

/** Task ids are UUIDs; anything else never becomes part of a file path. */
const safeId = (taskId: string): string => taskId.replace(/[^A-Za-z0-9_-]/g, "_");

export const incomingBundlePath = (taskId: string): string => path.join(dataDir(), "incoming", `${safeId(taskId)}.bundle`);

// ---------------------------------------------------------------- lease

interface LeaseRow {
  readonly lease_worker: string | null;
  readonly lease_expires_at: number | null;
  readonly status: string;
}

/** True while `workerId` holds a live lease on a running/waiting task (same rule as event ingestion). */
export function leaseOwnedBy(taskId: string, workerId: string, now = Date.now()): boolean {
  const row = getDb().prepare("SELECT lease_worker, lease_expires_at, status FROM tasks WHERE id = ?").get(taskId) as LeaseRow | undefined;
  return (
    row !== undefined &&
    row.lease_worker === workerId &&
    row.lease_expires_at !== null &&
    row.lease_expires_at >= now &&
    (row.status === "running" || row.status === "waiting")
  );
}

// ---------------------------------------------------------------- base bundle (GET)

type Loaded = { readonly task: Task; readonly project: Project; readonly workspace: TicketWorkspace };

function loadRemoteTask(taskId: string): Loaded | { readonly error: string } {
  const task = findTask(taskId);
  if (!task) return { error: "tarefa não encontrada" };
  const project = task.projectId ? findProject(task.projectId) : null;
  if (!project) return { error: "o projeto desta tarefa não existe mais" };
  const workspace = task.snapshot.workspace ?? null;
  const branch = workspace?.branch || taskBranch(task);
  return {
    task,
    project,
    workspace: workspace ? { ...workspace, branch } : { path: "", branch, base: NO_COMMITS_REF, prBase: null, commit: null, isActive: false },
  };
}

async function revParse(repoPath: string, ref: string): Promise<string | null> {
  const result = await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.ok ? firstLine(result.stdout) : null;
}

/**
 * Commit the worker starts from. A task branch left by an earlier attempt wins (the local runner
 * reuses it too); a repo without commits gets the same baseline snapshot branch the local runner
 * creates; otherwise the base ref recorded at claim time.
 */
async function baseCommitForWorker(loaded: Loaded): Promise<string | { readonly error: string }> {
  const { task, project, workspace } = loaded;
  const previous = await revParse(project.repoPath, `refs/heads/${workspace.branch}`);
  if (previous) return previous;
  if (workspace.base !== NO_COMMITS_REF) {
    return (await revParse(project.repoPath, workspace.base)) ?? { error: `a base "${workspace.base}" não existe mais no repositório` };
  }
  try {
    const wt = await prepareWorktree(project.repoPath, project.baseBranch, task.key, task.id);
    await releaseWorktree(project.repoPath, wt.path);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return (await revParse(project.repoPath, `refs/heads/${workspace.branch}`)) ?? { error: "não foi possível criar o snapshot de base" };
}

/** Branch name the base is published under inside the bundle: baseRef itself whenever git accepts it. */
async function bundleBranchName(repoPath: string, baseRef: string): Promise<string> {
  if (!baseRef || baseRef === NO_COMMITS_REF || baseRef === "HEAD") return FALLBACK_BASE_BRANCH;
  const valid = await git(repoPath, ["check-ref-format", "--branch", baseRef]);
  return valid.ok && firstLine(valid.stdout) === baseRef ? baseRef : FALLBACK_BASE_BRANCH;
}

export type BaseBundle = { readonly file: string; readonly ref: string } | { readonly error: string };

/**
 * Writes a git bundle of the task's starting point: `refs/heads/<baseRef>` and HEAD both point at
 * the base commit, so `git clone <bundle>` checks it out and `git checkout <baseRef>` works. The
 * bundle is built from a throwaway bare repo that borrows the project's objects (alternates), so
 * the project repo gets no extra refs. The caller streams the file and deletes it.
 */
export async function buildBaseBundle(taskId: string): Promise<BaseBundle> {
  const loaded = loadRemoteTask(taskId);
  if ("error" in loaded) return loaded;
  const { project, workspace } = loaded;
  const sha = await baseCommitForWorker(loaded);
  if (typeof sha !== "string") return sha;
  const common = await git(project.repoPath, ["rev-parse", "--git-common-dir"]);
  if (!common.ok) return { error: `o repositório do projeto não é um repositório git: ${firstLine(common.stderr)}` };
  const objects = path.resolve(project.repoPath, firstLine(common.stdout), "objects");
  const name = await bundleBranchName(project.repoPath, workspace.base);

  const outgoing = path.join(dataDir(), "outgoing");
  mkdirSync(outgoing, { recursive: true });
  const scratch = mkdtempSync(path.join(outgoing, "base-"));
  const bare = path.join(scratch, "repo.git");
  const file = path.join(outgoing, `${safeId(taskId)}-${randomBytes(4).toString("hex")}.bundle`);
  try {
    const init = await git(scratch, ["init", "-q", "--bare", bare]);
    if (!init.ok) return { error: `git init falhou: ${firstLine(init.stderr)}` };
    writeFileSync(path.join(bare, "objects", "info", "alternates"), `${objects}\n`, "utf8");
    const steps: readonly (readonly string[])[] = [
      ["update-ref", `refs/heads/${name}`, sha],
      ["symbolic-ref", "HEAD", `refs/heads/${name}`],
    ];
    for (const args of steps) {
      const result = await git(bare, args);
      if (!result.ok) return { error: `git ${args[0]} falhou: ${firstLine(result.stderr)}` };
    }
    const created = await git(bare, ["bundle", "create", file, "HEAD", `refs/heads/${name}`], BUNDLE_TIMEOUT_MS);
    if (!created.ok) {
      rmSync(file, { force: true });
      return { error: `git bundle create falhou: ${firstLine(created.stderr)}` };
    }
    return { file, ref: name };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- result bundle (PUT)

export type ReceiveOutcome = { readonly ok: true; readonly bytes: number } | { readonly ok: false; readonly reason: "too_large" | "empty" };

/**
 * Streams the worker's result bundle to dataDir()/incoming/<taskId>.bundle, never holding it in
 * memory. Above `maxBytes` the partial file is deleted and nothing replaces an earlier upload.
 */
export async function receiveBundle(taskId: string, body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<ReceiveOutcome> {
  if (!body) return { ok: false, reason: "empty" };
  const target = incomingBundlePath(taskId);
  mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.${randomBytes(4).toString("hex")}.part`;
  const handle = await open(partial, "w", 0o600);
  const reader = body.getReader();
  let total = 0;
  let keep = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      await handle.write(value);
    }
    if (total === 0) return { ok: false, reason: "empty" };
    keep = true;
  } finally {
    await handle.close();
    if (keep) renameSync(partial, target);
    else rmSync(partial, { force: true });
  }
  return { ok: true, bytes: total };
}

export const maxBundleBytes = (): number => getSettings().workers.maxBundleMb * MB;

// ---------------------------------------------------------------- import (POST result)

export type ImportOutcome = "lease_lost" | { readonly status: Ticket["status"]; readonly error: string | null };

class ImportError extends Error {}

const INCOMING_REF = (taskId: string) => `refs/carbon/incoming/${safeId(taskId)}`;

/** Fetches the worker's branch into a temporary ref and returns its full sha. */
async function fetchIncoming(repoPath: string, taskId: string, req: ResultRequest): Promise<string> {
  const temp = INCOMING_REF(taskId);
  if (req.transport === "bundle") {
    const file = incomingBundlePath(taskId);
    if (!existsSync(file) || statSync(file).size === 0) throw new ImportError("o worker não enviou o bundle do resultado (PUT bundle antes do result)");
    const verify = await git(repoPath, ["bundle", "verify", file], IMPORT_TIMEOUT_MS);
    if (!verify.ok) throw new ImportError(`bundle inválido: ${firstLine(verify.stderr)}`);
    const fetched = await git(repoPath, [...IMPORT_CONFIG, "fetch", "--no-tags", "--quiet", file, `+refs/heads/${req.branch}:${temp}`], IMPORT_TIMEOUT_MS);
    if (!fetched.ok) throw new ImportError(`não consegui importar o branch do bundle: ${firstLine(fetched.stderr)}`);
  } else {
    const fetched = await git(repoPath, [...IMPORT_CONFIG, "fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${req.branch}:${temp}`], IMPORT_TIMEOUT_MS);
    if (!fetched.ok) throw new ImportError(`git fetch origin ${req.branch} falhou: ${firstLine(fetched.stderr)}`);
  }
  const sha = await revParse(repoPath, temp);
  if (!sha) throw new ImportError("o branch importado não tem commit");
  return sha;
}

async function checkedOutIn(repoPath: string, branch: string): Promise<boolean> {
  const list = await git(repoPath, ["worktree", "list", "--porcelain"]);
  return list.ok && list.stdout.split("\n").some((line) => line.trim() === `branch refs/heads/${branch}`);
}

/**
 * Moves refs/heads/<branch> to the imported commit. Never rewrites history: an existing branch
 * must be an ancestor of the result, and a branch checked out somewhere is left alone.
 */
async function updateBranch(repoPath: string, branch: string, sha: string): Promise<void> {
  const current = await revParse(repoPath, `refs/heads/${branch}`);
  if (current && current !== sha) {
    const ancestor = await git(repoPath, ["merge-base", "--is-ancestor", current, sha]);
    if (!ancestor.ok) {
      throw new ImportError(`o branch ${branch} já existe no repositório com commits que não estão no resultado do worker; nada foi sobrescrito`);
    }
    if (await checkedOutIn(repoPath, branch)) throw new ImportError(`o branch ${branch} está em uso numa pasta (worktree); nada foi alterado`);
  }
  const updated = await git(repoPath, ["update-ref", "-m", "carbon: resultado do worker", `refs/heads/${branch}`, sha, current ?? ""]);
  if (!updated.ok) throw new ImportError(`não consegui atualizar o branch ${branch}: ${firstLine(updated.stderr)}`);
}

/** Commit the diff is measured from; falls back to origin/<base> when the base only exists remotely. */
async function diffBase(repoPath: string, workspace: TicketWorkspace): Promise<string | null> {
  const local = await baseCommitOf(repoPath, workspace);
  if (local) return local;
  if (workspace.base === NO_COMMITS_REF) return null;
  const remote = await git(repoPath, ["merge-base", `origin/${workspace.base}`, workspace.branch]);
  return remote.ok ? firstLine(remote.stdout) : null;
}

function emitTask(type: TaskEvent["type"], taskId: string, detail: string): void {
  liveEvents().emit(TASK_EVENT, { type, taskId, detail } satisfies TaskEvent);
}

function finish(t: LiveTicket, status: "done" | "failed", stage: StageId, text: string): void {
  t.log(stage, status === "done" ? "ok" : "warn", text);
  t.set({ ...t.get(), status, stage }, true);
  emitTask(status, t.get().id, text);
}

/** Push + PR when enabled and the repo has a remote: same rules and texts as the local deliver. */
async function deliver(task: Task, project: Project, t: LiveTicket, workspace: TicketWorkspace, costUsd: number): Promise<void> {
  const settings = getSettings();
  if (!settings.autoPush) {
    return t.log("deliver", "info", `push desligado. Abra o PR pelo card de entrega (escolha o branch de destino) ou revise: git log -1 --stat ${workspace.branch}`, true);
  }
  const origin = await git(project.repoPath, ["remote", "get-url", "origin"]);
  if (!origin.ok) return t.log("deliver", "info", `o repositório não tem remoto: revise o branch ${workspace.branch} localmente`, true);
  const isDraft = settings.acceptMode === "observe";
  const body = `Tarefa ${task.key} executada por Carbon (${task.executor}).\n\n${t.get().plan.map((s) => `- [${s.done ? "x" : " "}] ${s.text}`).join("\n")}\n\nCusto estimado: ${costUsd ? `US$ ${costUsd.toFixed(2)}` : "n/d"}.`;
  const pr = await pushAndOpenPr({ path: project.repoPath, branch: workspace.branch, prBase: workspace.prBase }, `${task.title} (${task.key})`, body, isDraft);
  if (!pr.ok || !pr.url) return t.log("deliver", "warn", pr.detail, true);

  const number = Number(/\/pull\/(\d+)/.exec(pr.url)?.[1] ?? 0);
  t.set({ ...t.get(), pr: { number, branch: workspace.branch, draft: isDraft, base: workspace.prBase ?? undefined, url: pr.url } });
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

/** Imports the branch, fills workspace + diff, delivers and records lessons. Throws ImportError. */
async function importDone(loaded: Loaded, t: LiveTicket, req: ResultRequest): Promise<void> {
  const { task, project } = loaded;
  const repoPath = project.repoPath;
  try {
    const sha = await fetchIncoming(repoPath, task.id, req);
    if (req.commit && !sha.startsWith(req.commit)) throw new ImportError(`o branch recebido aponta para ${sha.slice(0, 12)}, não para o commit ${req.commit} informado pelo worker`);
    await updateBranch(repoPath, req.branch, sha);
  } finally {
    await git(repoPath, ["update-ref", "-d", INCOMING_REF(task.id)]);
  }
  const short = firstLine((await git(repoPath, ["rev-parse", "--short", `refs/heads/${req.branch}`])).stdout);
  const workspace: TicketWorkspace = { ...loaded.workspace, branch: req.branch, commit: short || null, isActive: false, path: "" };
  const base = await diffBase(repoPath, workspace);
  const diff = base ? await diffBetween(repoPath, base, req.branch) : [];
  const reconciled = reconcilePlan({ ...t.get(), workspace, diff: [...diff] });
  t.set({ ...reconciled.ticket, stage: "deliver" }, true);
  t.log("deliver", "ok", `branch ${req.branch} importado (${req.transport === "bundle" ? "bundle" : "fetch do remoto"}) · commit ${short}`, true);
  if (reconciled.unconfirmed > 0) t.log("deliver", "warn", `${reconciled.unconfirmed} passo(s) do plano sem confirmação do agente — revise antes de aprovar`, true);

  const ctx = remoteRunContext(task.id, t.get());
  // A part of a distributed task stays on its branch: the parent integrates it and opens the PR.
  if (task.snapshot.parent) t.log("deliver", "info", `parte de ${task.snapshot.parent.key}: fica no branch ${workspace.branch}; a tarefa principal integra e abre o PR`, true);
  else await deliver(task, project, t, workspace, ctx.costUsd);
  t.set({ ...t.get(), stage: "reflect" }, true);
  for (const lesson of ctx.lessons) {
    addLesson(project.id, { ticketKey: task.key, rule: lesson.rule, evidence: lesson.evidence, scope: project.name, confidence: LESSON_CONFIDENCE });
  }
  t.log("reflect", "ok", `${ctx.lessons.length} lição(ões) candidata(s) para revisão`);
}

/**
 * RMT-02: the agent asked a CARBON_QUESTION. The task waits for a human (lease already released);
 * answering requeues it on the same runtime with resume=true, and the next claim carries the
 * decisions in the prompt. A remote run has no session to resume and its clone is gone, so the
 * next run starts again from the task base with the decisions as context.
 */
function parkOnQuestion(t: LiveTicket, stage: StageId): ImportOutcome {
  if (pendingQuestions(t.get()).length === 0) {
    const text = "o worker informou uma pergunta do agente, mas ela não chegou ao painel — use “rodar de novo”";
    finish(t, "failed", stage, text);
    return { status: "failed", error: text };
  }
  t.log(stage, "info", "execução remota: ao responder, a tarefa volta para a fila do mesmo runtime e o agente recomeça com as suas decisões no contexto");
  t.log(stage, "warn", "aguardando sua resposta no card de pergunta (acima do pipeline) para continuar");
  t.set({ ...t.get(), status: "waiting", stage }, true);
  emitTask("question", t.get().id, "aguardando sua resposta");
  return { status: "waiting", error: null };
}

/**
 * Applies a worker's final result. The lease is released first (atomically: a concurrent or
 * repeated result gets "lease_lost"), so a slow push/PR is never swept as a vanished worker.
 * The incoming bundle is always deleted.
 */
export async function importRemoteResult(taskId: string, workerId: string, req: ResultRequest, now = Date.now()): Promise<ImportOutcome> {
  if (!leaseOwnedBy(taskId, workerId, now) || !releaseLease(taskId, workerId)) return "lease_lost";
  const loaded = loadRemoteTask(taskId);
  try {
    if ("error" in loaded) {
      const task = findTask(taskId);
      if (task) finish(createLiveTicket(taskId, task.snapshot), "failed", task.snapshot.stage ?? "deliver", loaded.error);
      return { status: "failed", error: loaded.error };
    }
    // The run is over: prompts it forwarded can no longer be answered.
    const t = createLiveTicket(taskId, closeRemotePrompts(loaded.task.snapshot));
    const stage = t.get().stage ?? "code";
    if (req.status === "waiting") return parkOnQuestion(t, stage);
    if (req.status !== "done") {
      const text = req.status === "canceled" ? `cancelado${req.error ? `: ${req.error}` : ""}` : (req.error ?? "o worker reportou falha");
      finish(t, "failed", stage, text);
      return { status: "failed", error: text };
    }
    if (!req.commit) {
      t.set({ ...t.get(), stage: "deliver" }, true);
      t.log("deliver", "warn", "o agente não alterou arquivos — nada a entregar", true);
      finish(t, "done", "reflect", "ticket concluído");
      return { status: "done", error: null };
    }
    if (req.branch !== loaded.workspace.branch) {
      const text = `o worker entregou o branch "${req.branch}", mas esta tarefa usa "${loaded.workspace.branch}"; nada foi importado`;
      finish(t, "failed", stage, text);
      return { status: "failed", error: text };
    }
    try {
      await importDone(loaded, t, req);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      finish(t, "failed", t.get().stage ?? "deliver", text);
      return { status: "failed", error: text };
    }
    finish(t, "done", "reflect", "ticket concluído");
    return { status: "done", error: null };
  } finally {
    resetRemoteContext(taskId);
    rmSync(incomingBundlePath(taskId), { force: true });
  }
}
