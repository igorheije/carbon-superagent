import "server-only";
import type { Ticket } from "@/lib/domain/types";
import { commentOnIssue } from "../integrations/linear";
import { firstLine, run } from "../proc";
import { findProject } from "../repo/projects";
import { getSettings } from "../repo/settings";
import { findTask, saveSnapshot } from "../repo/tasks";
import { appendLog } from "./ticket-log";
import { pushAndOpenPr } from "./workspace";

/** Usual long-lived branches, offered first after the suggestion. */
const COMMON_TARGETS = ["main", "master", "develop", "staging", "homolog", "release"];
const FETCH_TIMEOUT_MS = 20_000;
/** Branch names Carbon accepts as a PR target (no option injection, no ranges). */
export const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

export interface TargetBranches {
  /** Ordered: suggestion, common long-lived branches, then the rest alphabetically. */
  readonly branches: readonly string[];
  readonly suggested: string | null;
  readonly hasRemote: boolean;
}

/**
 * Orders candidate targets. Carbon's own task branches (agent/*) and the task branch itself are
 * never offered as a destination.
 */
export function orderTargets(names: readonly string[], suggested: string | null, defaultBranch: string | null, taskBranch: string): TargetBranches {
  const unique = [...new Set(names.filter((n) => n && n !== "HEAD" && n !== taskBranch && !n.startsWith("agent/") && BRANCH_RE.test(n)))];
  const pick = [suggested, defaultBranch].find((n): n is string => Boolean(n && unique.includes(n))) ?? null;
  const common = COMMON_TARGETS.filter((n) => unique.includes(n) && n !== pick);
  const rest = unique.filter((n) => n !== pick && !common.includes(n)).sort((a, b) => a.localeCompare(b));
  return { branches: [...(pick ? [pick] : []), ...common, ...rest], suggested: pick, hasRemote: unique.length > 0 };
}

const git = (cwd: string, args: readonly string[], timeoutMs = 30_000) => run("git", args, { cwd, timeoutMs });

/** Remote branches of the task's repository, refreshed with a best-effort fetch. */
export async function listTargetBranches(taskId: string): Promise<TargetBranches | { readonly error: string }> {
  const task = findTask(taskId);
  if (!task) return { error: "tarefa não encontrada" };
  const project = task.projectId ? findProject(task.projectId) : null;
  if (!project) return { error: "o projeto desta tarefa não existe mais" };
  const workspace = task.snapshot.workspace;
  await git(project.repoPath, ["fetch", "--prune", "origin"], FETCH_TIMEOUT_MS);
  const refs = await git(project.repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
  const names = refs.ok ? refs.stdout.split("\n").map((l) => l.trim().replace(/^origin\//, "")).filter((l) => l && l !== "origin") : [];
  const head = await git(project.repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const defaultBranch = head.ok ? firstLine(head.stdout).replace(/^origin\//, "") : null;
  return orderTargets(names, workspace?.prBase ?? null, defaultBranch, workspace?.branch ?? "");
}

export type OpenPrResult = { readonly ok: true; readonly url: string; readonly ticket: Ticket } | { readonly ok: false; readonly error: string };

/** Pushes the task branch and opens a PR against the chosen target, after a manual delivery. */
export async function openPullRequest(taskId: string, base: string, draft: boolean, userName: string): Promise<OpenPrResult> {
  const task = findTask(taskId);
  if (!task) return { ok: false, error: "tarefa não encontrada" };
  const ticket = task.snapshot;
  const workspace = ticket.workspace;
  if (ticket.status !== "done") return { ok: false, error: "só tarefas concluídas podem virar PR" };
  if (ticket.pr) return { ok: false, error: `já existe o PR #${ticket.pr.number} para esta tarefa` };
  if (!workspace?.commit) return { ok: false, error: "esta tarefa não tem commit para enviar" };
  if (!BRANCH_RE.test(base)) return { ok: false, error: "nome de branch inválido" };

  const targets = await listTargetBranches(taskId);
  if ("error" in targets) return { ok: false, error: targets.error };
  if (!targets.branches.includes(base)) return { ok: false, error: `o branch "${base}" não existe no remoto` };

  const plan = ticket.plan.map((s) => `- [${s.done ? "x" : " "}] ${s.text}`).join("\n");
  const body = `Tarefa ${task.key} executada por Carbon (${task.executor}). PR aberto por ${userName}.\n\n${plan}`;
  const pr = await pushAndOpenPr({ path: workspace.path, branch: workspace.branch, prBase: base }, `${task.title} (${task.key})`, body, draft);
  if (!pr.ok || !pr.url) return { ok: false, error: pr.detail };

  const number = Number(/\/pull\/(\d+)/.exec(pr.url)?.[1] ?? 0);
  const next = appendLog(
    { ...ticket, pr: { number, branch: workspace.branch, draft, base, url: pr.url } },
    "deliver",
    "ok",
    `PR ${pr.url} → ${base}${draft ? " (draft)" : ""} · aberto por ${userName}`,
  );
  saveSnapshot(task.id, next);

  const settings = getSettings();
  if (task.source === "linear" && task.sourceRef && settings.linearApiKey) {
    await commentOnIssue(settings.linearApiKey, task.sourceRef, `Carbon abriu ${pr.url} para esta issue.`).catch(() => undefined);
  }
  return { ok: true, url: pr.url, ticket: next };
}
