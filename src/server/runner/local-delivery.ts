import "server-only";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Ticket, TicketWorkspace } from "@/lib/domain/types";
import { firstLine, run } from "../proc";
import { findProject } from "../repo/projects";
import { findTask, saveSnapshot, type Task } from "../repo/tasks";
import { BRANCH_RE } from "./pull-request";
import { appendLog } from "./ticket-log";

const NO_COMMITS_BASE = "(sem commits)";
const IDENTITY = ["-c", "user.name=Carbon Agent", "-c", "user.email=carbon@localhost"];

const git = (cwd: string, args: readonly string[], timeoutMs = 60_000) => run("git", args, { cwd, timeoutMs });

export interface LocalTargets {
  /** Local branches that can receive a merge (Carbon's agent/* branches excluded). */
  readonly branches: readonly string[];
  /** Branch checked out in the main repo folder (may have no commits yet). */
  readonly current: string | null;
  readonly suggested: string | null;
  /** False for a repository without any commit: merging needs a branch with history. */
  readonly hasCommits: boolean;
}

type Loaded = { readonly task: Task; readonly ticket: Ticket; readonly workspace: TicketWorkspace; readonly repoPath: string };

function load(taskId: string): Loaded | { readonly error: string } {
  const task = findTask(taskId);
  if (!task) return { error: "tarefa não encontrada" };
  const project = task.projectId ? findProject(task.projectId) : null;
  if (!project) return { error: "o projeto desta tarefa não existe mais" };
  const workspace = task.snapshot.workspace;
  if (!workspace?.branch || !workspace.commit) return { error: "esta tarefa não tem commit para levar" };
  if (task.snapshot.status === "running" || task.snapshot.status === "queued") return { error: "espere a tarefa terminar" };
  return { task, ticket: task.snapshot, workspace, repoPath: project.repoPath };
}

export async function listLocalTargets(taskId: string): Promise<LocalTargets | { readonly error: string }> {
  const loaded = load(taskId);
  if ("error" in loaded) return loaded;
  const { repoPath, workspace } = loaded;
  const heads = await git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const branches = heads.ok ? heads.stdout.split("\n").map((l) => l.trim()).filter((b) => b && !b.startsWith("agent/") && BRANCH_RE.test(b)) : [];
  const head = await git(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const current = head.ok ? firstLine(head.stdout) : null;
  const hasCommits = (await git(repoPath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).ok;
  const preferred = [workspace.prBase, current].find((b): b is string => Boolean(b && branches.includes(b))) ?? branches[0] ?? null;
  return { branches, current, suggested: preferred, hasCommits };
}

/** Commit the task branch started from: the snapshot baseline for repos without commits. */
export async function baseCommitOf(repoPath: string, workspace: TicketWorkspace): Promise<string | null> {
  if (workspace.base === NO_COMMITS_BASE) {
    const root = await git(repoPath, ["rev-list", "--max-parents=0", workspace.branch]);
    return root.ok ? firstLine(root.stdout) : null;
  }
  const mergeBase = await git(repoPath, ["merge-base", workspace.base, workspace.branch]);
  return mergeBase.ok ? firstLine(mergeBase.stdout) : null;
}

function record(task: Task, ticket: Ticket, patch: Partial<TicketWorkspace>, text: string): Ticket {
  const next = appendLog({ ...ticket, workspace: { ...(ticket.workspace as TicketWorkspace), ...patch } }, "deliver", "ok", text);
  saveSnapshot(task.id, next);
  return next;
}

export type LocalResult = { readonly ok: true; readonly detail: string } | { readonly ok: false; readonly error: string };

/**
 * Applies the task's changes to the repo's working folder as uncommitted edits, for review and
 * commit by the person. Works for repositories without commits too. All-or-nothing: the patch is
 * checked first and nothing is written when it does not apply cleanly.
 */
export async function applyToWorkingDir(taskId: string, userName: string): Promise<LocalResult> {
  const loaded = load(taskId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const { task, ticket, workspace, repoPath } = loaded;
  const base = await baseCommitOf(repoPath, workspace);
  if (!base) return { ok: false, error: "não encontrei o ponto de partida do branch da tarefa" };
  const diff = await git(repoPath, ["diff", "--binary", base, workspace.branch], 120_000);
  if (!diff.ok) return { ok: false, error: `git diff falhou: ${firstLine(diff.stderr)}` };
  if (!diff.stdout.trim()) return { ok: false, error: "a tarefa não tem mudanças em relação ao ponto de partida" };

  const dir = mkdtempSync(path.join(tmpdir(), "carbon-apply-"));
  const patchFile = path.join(dir, "task.patch");
  try {
    writeFileSync(patchFile, diff.stdout, "utf8");
    const check = await git(repoPath, ["apply", "--check", patchFile]);
    if (!check.ok) {
      // Already in the folder (applied before, or by hand): the patch reverses cleanly. Nothing to do.
      const present = await git(repoPath, ["apply", "--reverse", "--check", patchFile]);
      if (present.ok) {
        if (!workspace.appliedAt) record(task, ticket, { appliedAt: new Date().toISOString() }, `${userName} conferiu: as mudanças da tarefa já estavam na pasta do projeto`);
        return { ok: true, detail: `As mudanças desta tarefa já estão em ${repoPath}. Nada foi alterado; revise com git status e faça o commit.` };
      }
      const hint = workspace.appliedAt
        ? "a tarefa já foi aplicada antes e esses arquivos mudaram desde então"
        : "alguém já mexeu nesses arquivos?";
      return { ok: false, error: `as mudanças não se aplicam limpas na sua pasta (${hint}). Nada foi alterado: ${firstLine(check.stderr)}` };
    }
    const applied = await git(repoPath, ["apply", patchFile]);
    if (!applied.ok) return { ok: false, error: `git apply falhou: ${firstLine(applied.stderr)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const files = await git(repoPath, ["diff", "--name-only", base, workspace.branch]);
  const count = files.ok ? files.stdout.split("\n").filter(Boolean).length : 0;
  record(task, ticket, { appliedAt: new Date().toISOString() }, `${userName} aplicou ${count} arquivo(s) da tarefa na pasta do projeto (sem commit)`);
  return { ok: true, detail: `${count} arquivo(s) aplicados em ${repoPath}. Revise com git status e faça o commit.` };
}

async function merge(cwd: string, branch: string, message: string): Promise<LocalResult> {
  const email = await git(cwd, ["config", "user.email"]);
  const identity = email.ok && email.stdout.trim() ? [] : IDENTITY;
  const merged = await git(cwd, [...identity, "merge", "--no-ff", "--no-edit", "-m", message, branch], 120_000);
  if (merged.ok) return { ok: true, detail: firstLine(merged.stdout) };
  await git(cwd, ["merge", "--abort"]);
  return { ok: false, error: `merge com conflito ou erro, nada foi alterado: ${firstLine(merged.stderr || merged.stdout)}` };
}

/**
 * Files that would conflict if the task branch were merged into `target`, computed with
 * `git merge-tree` (no worktree, index or ref is touched). Empty when it merges cleanly.
 */
export async function conflictsWith(taskId: string, target: string): Promise<{ readonly files: readonly string[] } | { readonly error: string }> {
  if (!BRANCH_RE.test(target) || target.startsWith("agent/")) return { error: "branch de destino inválido" };
  const loaded = load(taskId);
  if ("error" in loaded) return { error: loaded.error };
  const { workspace, repoPath } = loaded;
  const tree = await git(repoPath, ["merge-tree", "--write-tree", "--name-only", "--no-messages", target, workspace.branch]);
  // Exit 0 = clean, 1 = conflicts; anything else (or no output) is an error.
  const lines = tree.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (tree.ok) return { files: [] };
  if (lines.length > 1) return { files: [...new Set(lines.slice(1))] };
  return { error: `não consegui verificar os conflitos: ${firstLine(tree.stderr || tree.stdout)}` };
}

/**
 * Merges the task branch into a local branch. When the target is the branch checked out in the
 * repo folder, that folder must be clean; any other target is merged in a temporary worktree, so
 * the person's folder is never touched. Conflicts abort the merge.
 */
export async function mergeIntoBranch(taskId: string, target: string, userName: string): Promise<LocalResult> {
  if (!BRANCH_RE.test(target) || target.startsWith("agent/")) return { ok: false, error: "branch de destino inválido" };
  const targets = await listLocalTargets(taskId);
  if ("error" in targets) return { ok: false, error: targets.error };
  if (!targets.hasCommits) return { ok: false, error: "o repositório não tem commits: use “aplicar na minha pasta”" };
  if (!targets.branches.includes(target)) return { ok: false, error: `o branch "${target}" não existe localmente` };
  const loaded = load(taskId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const { task, ticket, workspace, repoPath } = loaded;
  const message = `Merge ${workspace.branch} (${task.key}) into ${target}`;

  if (target === targets.current) {
    const dirty = await git(repoPath, ["status", "--porcelain", "--untracked-files=no"]);
    if (!dirty.ok || dirty.stdout.trim()) return { ok: false, error: `a sua pasta tem mudanças não commitadas em ${target}: faça commit ou stash antes do merge` };
    const result = await merge(repoPath, workspace.branch, message);
    if (!result.ok) return result;
  } else {
    const dir = mkdtempSync(path.join(tmpdir(), "carbon-merge-"));
    const temp = path.join(dir, "wt");
    try {
      const added = await git(repoPath, ["worktree", "add", temp, target]);
      if (!added.ok) return { ok: false, error: `não consegui preparar o merge: ${firstLine(added.stderr)}` };
      const result = await merge(temp, workspace.branch, message);
      if (!result.ok) return result;
    } finally {
      if (existsSync(temp)) await git(repoPath, ["worktree", "remove", "--force", temp]);
      await git(repoPath, ["worktree", "prune"]);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  record(task, ticket, { mergedInto: target }, `${userName} fez merge de ${workspace.branch} em ${target}`);
  return { ok: true, detail: `${workspace.branch} foi mesclado em ${target}.` };
}
