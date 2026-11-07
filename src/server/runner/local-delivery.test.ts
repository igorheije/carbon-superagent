import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TicketWorkspace } from "@/lib/domain/types";

// Real git repositories and a throwaway database: these paths touch the user's working folder,
// so they are exercised for real instead of mocked.
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-local-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@localhost"];
const git = (cwd: string, ...args: string[]): string => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

type Modules = {
  tasks: typeof import("../repo/tasks");
  projects: typeof import("../repo/projects");
  users: typeof import("../repo/users");
  local: typeof import("./local-delivery");
  worktree: typeof import("./worktree");
};
let m: Modules;
let ownerId = "";

beforeAll(async () => {
  m = {
    tasks: await import("../repo/tasks"),
    projects: await import("../repo/projects"),
    users: await import("../repo/users"),
    local: await import("./local-delivery"),
    worktree: await import("./worktree"),
  };
  ownerId = m.users.createUser({ email: "a@b.c", name: "Ana", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false }).id;
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function repo(name: string, withCommit: boolean): string {
  const dir = path.join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "# projeto\nlinha original\n");
  if (withCommit) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

/** A finished task whose branch has one commit changing README.md. */
async function deliveredTask(repoPath: string, key: string, edit = "linha do agente\n") {
  const project = m.projects.findProjectByRepo(repoPath) ?? m.projects.createProject({ name: key, repoPath, baseBranch: "" });
  const task = m.tasks.createTask({
    projectId: project.id, key, title: "t", description: "d", source: "manual", sourceRef: null, requesterId: ownerId, requesterName: "Ana",
    persona: "engineering", executor: "claude", model: "auto", effort: "auto", priority: "medium", repo: project.name, modelLabel: "x",
  });
  const wt = await m.worktree.prepareWorktree(repoPath, "", key, task.id, path.join(sandbox, "wts"));
  writeFileSync(path.join(wt.path, "README.md"), `${readFileSync(path.join(wt.path, "README.md"), "utf8")}${edit}`);
  writeFileSync(path.join(wt.path, "novo.txt"), "arquivo novo\n");
  git(wt.path, "add", "-A");
  git(wt.path, "commit", "-q", "-m", "feat: agente");
  const workspace: TicketWorkspace = { path: wt.path, branch: wt.branch, base: wt.base, prBase: wt.prBase, commit: git(wt.path, "rev-parse", "--short", "HEAD"), isActive: true };
  m.tasks.saveSnapshot(task.id, { ...task.snapshot, status: "done", workspace });
  return { taskId: task.id, workspace };
}

describe("repository without commits", () => {
  it("applies the task changes to the project folder, and refuses a merge", async () => {
    const dir = repo("unborn", false);
    const { taskId } = await deliveredTask(dir, "ig-1");
    const targets = await m.local.listLocalTargets(taskId);
    expect(targets).toMatchObject({ hasCommits: false, current: "main" });

    expect(await m.local.mergeIntoBranch(taskId, "main", "Ana")).toMatchObject({ ok: false });
    const applied = await m.local.applyToWorkingDir(taskId, "Ana");
    expect(applied.ok).toBe(true);
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toContain("linha do agente");
    expect(readFileSync(path.join(dir, "novo.txt"), "utf8")).toBe("arquivo novo\n");
    expect(m.tasks.findTask(taskId)?.snapshot.workspace?.appliedAt).toBeTruthy();

    // Applying again (e.g. after a reload) is a no-op: the changes are already there.
    const again = await m.local.applyToWorkingDir(taskId, "Ana");
    expect(again).toMatchObject({ ok: true });
    expect(again.ok && again.detail).toContain("já estão");
    expect(readFileSync(path.join(dir, "README.md"), "utf8").match(/linha do agente/g)).toHaveLength(1);

    // Edited after applying: refuses, says why and touches nothing.
    writeFileSync(path.join(dir, "novo.txt"), "editado pela pessoa\n");
    const edited = await m.local.applyToWorkingDir(taskId, "Ana");
    expect(edited).toMatchObject({ ok: false });
    expect(!edited.ok && edited.error).toContain("já foi aplicada antes");
    expect(readFileSync(path.join(dir, "novo.txt"), "utf8")).toBe("editado pela pessoa\n");
  });
});

describe("repository with history", () => {
  it("merges into the checked-out branch when the folder is clean", async () => {
    const dir = repo("merge-current", true);
    const { taskId } = await deliveredTask(dir, "api-1");
    const result = await m.local.mergeIntoBranch(taskId, "main", "Ana");
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(dir, "novo.txt"), "utf8")).toBe("arquivo novo\n");
    expect(m.tasks.findTask(taskId)?.snapshot.workspace?.mergedInto).toBe("main");
  });

  it("merges into another branch without touching the person's folder", async () => {
    const dir = repo("merge-other", true);
    git(dir, "branch", "develop");
    const { taskId, workspace } = await deliveredTask(dir, "api-2");
    expect((await m.local.mergeIntoBranch(taskId, "develop", "Ana")).ok).toBe(true);
    expect(git(dir, "log", "develop", "--oneline")).toContain("Merge");
    expect(git(dir, "branch", "--show-current")).toBe("main");
    expect(existsSync(path.join(dir, "novo.txt"))).toBe(false);
    expect(git(dir, "branch", "--contains", workspace.branch)).toContain("develop");
  });

  it("aborts on conflict and refuses a dirty checked-out branch", async () => {
    const dir = repo("conflict", true);
    const { taskId } = await deliveredTask(dir, "api-3");
    writeFileSync(path.join(dir, "README.md"), "# projeto\nlinha original\nmudança humana no mesmo lugar\n");
    expect(await m.local.mergeIntoBranch(taskId, "main", "Ana")).toMatchObject({ ok: false });
    git(dir, "commit", "-qam", "humano");
    const conflict = await m.local.mergeIntoBranch(taskId, "main", "Ana");
    expect(conflict).toMatchObject({ ok: false });
    expect(existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });
});

describe("releaseWorktree", () => {
  it("keeps dirty worktrees, removes clean ones and always keeps the branch", async () => {
    const dir = repo("release", true);
    const { workspace } = await deliveredTask(dir, "rel-1");
    writeFileSync(path.join(workspace.path, "rascunho.txt"), "não commitado\n");
    expect(await m.worktree.releaseWorktree(dir, workspace.path)).toBe("dirty");
    expect(existsSync(workspace.path)).toBe(true);
    rmSync(path.join(workspace.path, "rascunho.txt"));
    expect(await m.worktree.releaseWorktree(dir, workspace.path)).toBe("removed");
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(dir, "branch", "--list", workspace.branch)).toContain(workspace.branch);
    expect(await m.worktree.releaseWorktree(dir, workspace.path)).toBe("missing");
  });
});

describe("conflictsWith (\"Resolver conflito com o agente\")", () => {
  it("lists the conflicting files without touching the repo, and is empty for a clean merge", async () => {
    const dir = repo("conflict-preview", true);
    const { taskId } = await deliveredTask(dir, "cf-1", "linha do agente\n");
    // Someone changes the same line on main after the task branched.
    writeFileSync(path.join(dir, "README.md"), "# projeto\nlinha original\nlinha da main\n");
    git(dir, "commit", "-q", "-am", "main mexeu no README");
    const head = git(dir, "rev-parse", "HEAD");

    expect(await m.local.conflictsWith(taskId, "main")).toEqual({ files: ["README.md"] });
    // Nothing changed: same HEAD, clean folder, no merge in progress.
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);

    const clean = repo("conflict-none", true);
    const { taskId: cleanTask } = await deliveredTask(clean, "cf-2");
    expect(await m.local.conflictsWith(cleanTask, "main")).toEqual({ files: [] });
  });

  it("rejects agent branches and invalid names as the target", async () => {
    const dir = repo("conflict-bad", true);
    const { taskId } = await deliveredTask(dir, "cf-3");
    expect(await m.local.conflictsWith(taskId, "agent/x")).toEqual({ error: "branch de destino inválido" });
    expect(await m.local.conflictsWith(taskId, "a b")).toEqual({ error: "branch de destino inválido" });
  });
});
