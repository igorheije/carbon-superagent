import "server-only";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { firstLine, run } from "../proc";
import { dataDir } from "../db";
import { findProject } from "../repo/projects";
import { listTasks, saveSnapshot } from "../repo/tasks";
import { releaseWorktree, worktreeName } from "./worktree";

const FINISHED = new Set(["done", "failed"]);
const SCAN_LIMIT = 500;

/**
 * Boot sweep: worktrees left behind by finished tasks (before worktrees became temporary, or after
 * a crash) are removed when clean. Branches stay; dirty worktrees stay. Returns how many went away.
 */
export async function releaseFinishedWorktrees(): Promise<number> {
  const known = new Set<string>();
  let removed = 0;
  for (const task of listTasks(null, SCAN_LIMIT)) {
    known.add(worktreeName(task.key, task.id));
    if (!FINISHED.has(task.status) || !task.projectId) continue;
    const project = findProject(task.projectId);
    if (!project) continue;
    const workspace = task.snapshot.workspace;
    if (workspace?.isActive === false) continue;
    const folder = workspace?.path || path.join(dataDir(), "worktrees", worktreeName(task.key, task.id));
    const result = await releaseWorktree(project.repoPath, folder);
    if (result !== "removed") continue;
    removed += 1;
    if (workspace) saveSnapshot(task.id, { ...task.snapshot, workspace: { ...workspace, isActive: false } });
  }
  return removed + (await releaseOrphanWorktrees(known));
}

/** Folders under worktrees/ whose task was deleted: the owning repo is found through git itself. */
async function releaseOrphanWorktrees(known: ReadonlySet<string>): Promise<number> {
  const root = path.join(dataDir(), "worktrees");
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || known.has(entry.name) || entry.name.includes(".stale-")) continue;
    const folder = path.join(root, entry.name);
    const common = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, timeoutMs: 10_000 });
    if (!common.ok) continue;
    const gitDir = firstLine(common.stdout);
    if (path.basename(gitDir) !== ".git") continue;
    if ((await releaseWorktree(path.dirname(gitDir), folder)) === "removed") removed += 1;
  }
  return removed;
}
