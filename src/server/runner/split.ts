import "server-only";
import type { MergeResult, SplitChild, SubtaskSpec, Ticket } from "@/lib/domain/types";
import { firstLine, run } from "../proc";
import { getSettings } from "../repo/settings";
import { createTask, findTask, listTasksByStatus, moveToFront, saveSnapshot, type Task } from "../repo/tasks";
import { listWorkers } from "../repo/workers";
import { appendLog } from "./apply";
import { notifyLive } from "./live";
import type { MergeReportEntry } from "./split-prompt";

/**
 * Distributed tasks (fan-out / fan-in). The parent runs on the panel: it declares parts with
 * CARBON_SUBTASK and stops; Carbon commits its groundwork, creates one subtask per part (on the
 * pool when a machine is online), and parks the parent in "waiting". When every subtask is final,
 * the reconciler queues the parent again to integrate: the runner merges each subtask branch into
 * the parent's worktree (mergeSubtasks) and the agent finishes, tests and delivers one PR.
 */

const CARBON_IDENTITY = ["-c", "user.name=Carbon Agent", "-c", "user.email=carbon@localhost"];
const MAX_PATCH_CHARS = 12_000;
const FINAL: ReadonlySet<Ticket["status"]> = new Set(["done", "failed"]);

const git = (cwd: string, args: readonly string[], timeoutMs = 120_000) => run("git", args, { cwd, timeoutMs });

/** Pool machines that would claim a subtask right now (active, not removed, seen recently). */
export function onlinePoolWorkers(now = Date.now()): number {
  const window = 2 * getSettings().workers.leaseMs;
  return listWorkers().filter((w) => w.kind === "pool" && w.revokedAt === null && w.availability === "active" && w.lastSeenAt !== null && now - w.lastSeenAt <= window).length;
}

/** Creates the subtasks of `parent` and parks it in "waiting". Returns the ticket to keep in the tracker. */
export function createSubtasks(parent: Task, ticket: Ticket, branch: string, parts: readonly SubtaskSpec[], now = new Date()): Ticket {
  const runtime = onlinePoolWorkers() > 0 ? "pool" : "local";
  const children: SplitChild[] = parts.map((part, index) => {
    const child = createTask({
      projectId: parent.projectId ?? "",
      key: `${parent.key}.${index + 1}`,
      title: part.title,
      description: part.brief,
      source: "manual",
      sourceRef: null,
      requesterId: parent.requesterId,
      requesterName: ticket.requester,
      persona: parent.persona,
      executor: parent.executor,
      model: parent.model,
      effort: parent.effort,
      priority: ticket.priority,
      repo: ticket.repo,
      modelLabel: ticket.model ?? "",
      runtime,
    });
    saveSnapshot(child.id, {
      ...child.snapshot,
      parent: { id: parent.id, key: parent.key, title: parent.title },
      subtask: part,
      baseBranch: branch,
    });
    return { id: child.id, key: child.key, title: part.title, files: part.files };
  });
  // Subtasks go first in line, in order, so a free machine picks them up right away.
  for (const child of [...children].reverse()) moveToFront(child.id);
  const where = runtime === "pool" ? `nos computadores do cluster (${onlinePoolWorkers()} online)` : "neste computador, uma por vez (nenhum computador do cluster online)";
  const logged = appendLog(ticket, ticket.stage ?? "code", "ok", `tarefa dividida em ${children.length} parte(s) · rodando ${where}`);
  return { ...logged, split: { phase: "running", children, createdAt: now.toISOString() } };
}

/**
 * Queues every waiting parent whose subtasks are all final, first in line, to integrate them.
 * Returns the parents queued. Safe to call often (from the runner and on an interval).
 */
export function reconcileSplits(): readonly string[] {
  const queued: string[] = [];
  for (const parent of listTasksByStatus("waiting")) {
    const split = parent.snapshot.split;
    if (!split || split.phase !== "running") continue;
    const children = split.children.map((c) => findTask(c.id));
    if (!children.every((c) => c === null || FINAL.has(c.status))) continue;
    const doneCount = children.filter((c) => c?.status === "done").length;
    const ticket = appendLog(
      { ...parent.snapshot, status: "queued", resume: true, split: { ...split, phase: "integrating" } },
      parent.snapshot.stage ?? "code",
      "info",
      `as ${split.children.length} parte(s) terminaram (${doneCount} concluída(s)): integrando`,
    );
    saveSnapshot(parent.id, ticket);
    moveToFront(parent.id);
    queued.push(parent.id);
  }
  if (queued.length > 0) notifyLive();
  return queued;
}

/** "Rodar de novo" on a parent: subtasks not yet final are stopped and the split is dropped. */
export function cancelSubtasks(parent: Task): number {
  const split = parent.snapshot.split;
  if (!split) return 0;
  let cancelled = 0;
  for (const ref of split.children) {
    const child = findTask(ref.id);
    if (!child || FINAL.has(child.status)) continue;
    if (child.status === "running") continue; // a running subtask is stopped by its worker lease/cancel flow
    saveSnapshot(child.id, appendLog({ ...child.snapshot, status: "failed" }, child.snapshot.stage ?? "intake", "warn", `cancelada: a tarefa ${parent.key} recomeçou`));
    cancelled += 1;
  }
  return cancelled;
}

function lastWarning(ticket: Ticket): string {
  return [...ticket.logs].reverse().find((l) => l.level === "warn")?.text ?? "a subtarefa falhou sem detalhe";
}

/**
 * Merges each finished subtask branch into the parent's worktree (already on the parent branch).
 * A conflict aborts that merge and hands its patch to the agent. Never leaves a merge half-done.
 */
export async function mergeSubtasks(worktreePath: string, split: NonNullable<Ticket["split"]>): Promise<readonly MergeReportEntry[]> {
  const report: MergeReportEntry[] = [];
  for (const ref of split.children) {
    const child = findTask(ref.id);
    const base = { key: ref.key, title: ref.title };
    if (!child || child.status !== "done") {
      report.push({ ...base, result: "failed", detail: child ? lastWarning(child.snapshot) : "a subtarefa foi apagada" });
      continue;
    }
    const branch = child.snapshot.workspace?.branch;
    const ahead = branch ? await git(worktreePath, ["rev-list", "--count", `HEAD..${branch}`]) : null;
    if (!branch || !ahead?.ok || Number(firstLine(ahead.stdout)) === 0) {
      report.push({ ...base, result: "empty" });
      continue;
    }
    const merged = await git(worktreePath, [...CARBON_IDENTITY, "merge", "--no-ff", "--no-edit", "-m", `merge: ${ref.key} ${ref.title} (Carbon)`, branch]);
    if (merged.ok) {
      report.push({ ...base, result: "merged" });
      continue;
    }
    await git(worktreePath, ["merge", "--abort"]);
    const patch = await git(worktreePath, ["diff", `HEAD...${branch}`]);
    const text = patch.ok ? patch.stdout : `não foi possível gerar o patch: ${firstLine(patch.stderr)}`;
    report.push({ ...base, result: "conflict", detail: text.length > MAX_PATCH_CHARS ? `${text.slice(0, MAX_PATCH_CHARS)}\n… (patch cortado; veja git diff HEAD...${branch})` : text });
  }
  return report;
}

/** Writes each part's merge result on the split, for the panel. */
export function withMergeResults(split: NonNullable<Ticket["split"]>, report: readonly MergeReportEntry[]): NonNullable<Ticket["split"]> {
  const byKey = new Map(report.map((r) => [r.key, r.result] as const));
  return { ...split, children: split.children.map((c) => ({ ...c, merge: byKey.get(c.key) as MergeResult | undefined })) };
}
