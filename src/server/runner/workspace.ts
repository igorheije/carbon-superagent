import "server-only";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DiffFile } from "@/lib/domain/types";
import { dataDir } from "../db";
import { MEMORY_WORKTREE_DIR, type RepoMemory } from "../knowledge/claude-memory";
import { firstLine, run } from "../proc";
import type { Skill } from "../repo/skills";
import { toSkillMarkdown } from "../skills/parse";
import { prepareWorktree as prepareIsolatedWorktree, type Worktree } from "./worktree";

const MAX_DIFF_FILES = 12;
const MAX_SNIPPET_LINES = 8;

export type { Worktree } from "./worktree";

async function git(cwd: string, args: readonly string[], timeoutMs = 60_000) {
  return run("git", args, { cwd, timeoutMs });
}

export function prepareWorktree(repoPath: string, baseBranch: string, key: string, taskId: string): Promise<Worktree> {
  return prepareIsolatedWorktree(repoPath, baseBranch, key, taskId, path.join(dataDir(), "worktrees"));
}

const materializedName = (name: string): string => (name.startsWith("carbon-") ? name : `carbon-${name}`);

/** Writes skills where each CLI discovers them; returns paths for the prompt. */
export function materializeSkills(worktreePath: string, skills: readonly Skill[]) {
  return skills.map((skill) => {
    const name = materializedName(skill.name);
    const markdown = toSkillMarkdown({ name, description: skill.description, body: skill.body });
    for (const root of [".claude/skills", ".codex/skills"]) {
      const dir = path.join(worktreePath, root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), markdown, "utf8");
    }
    return { name, description: skill.description, path: `.claude/skills/${name}/SKILL.md` };
  });
}

/** Copy of the repo's Claude Code memory for the agent to open on demand; excluded from commits. */
export function writeClaudeMemory(worktreePath: string, memory: RepoMemory): void {
  const dir = path.join(worktreePath, MEMORY_WORKTREE_DIR);
  mkdirSync(dir, { recursive: true });
  for (const file of memory.files) writeFileSync(path.join(dir, path.basename(file.name)), `${file.content}\n`, "utf8");
}

/** Full project map for the agent; excluded from commits like the skills. */
export function writeProjectMap(worktreePath: string, markdown: string): void {
  const dir = path.join(worktreePath, ".carbon");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "PROJECT_MAP.md"), markdown, "utf8");
}

function snippetFor(patch: string): readonly string[] {
  return patch
    .split("\n")
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"))
    .slice(0, MAX_SNIPPET_LINES)
    .map((l) => l.slice(0, 160));
}

/** Stages everything and summarizes it. Returns [] when the agent changed nothing. */
export async function collectDiff(worktreePath: string): Promise<readonly DiffFile[]> {
  await git(worktreePath, ["add", "-A"]);
  const numstat = await git(worktreePath, ["diff", "--cached", "--numstat"]);
  const rows = numstat.stdout.split("\n").filter(Boolean).slice(0, MAX_DIFF_FILES);
  return Promise.all(
    rows.map(async (row) => {
      const [add = "0", del = "0", ...rest] = row.split("\t");
      const file = rest.join("\t");
      const patch = await git(worktreePath, ["diff", "--cached", "-U0", "--", file]);
      return { path: file, additions: Number(add) || 0, deletions: Number(del) || 0, snippet: snippetFor(patch.stdout) };
    }),
  );
}

export async function commit(worktreePath: string, message: string): Promise<{ readonly ok: boolean; readonly detail: string; readonly sha: string | null }> {
  const email = await git(worktreePath, ["config", "user.email"]);
  const identity = email.ok && email.stdout.trim() ? [] : ["-c", "user.name=Carbon Agent", "-c", "user.email=carbon@localhost"];
  const result = await git(worktreePath, [...identity, "commit", "-m", message]);
  if (!result.ok) return { ok: false, detail: firstLine(result.stderr), sha: null };
  const head = await git(worktreePath, ["rev-parse", "--short", "HEAD"]);
  return { ok: true, detail: firstLine(result.stdout), sha: head.ok ? firstLine(head.stdout) : null };
}

export async function pushAndOpenPr(
  wt: Pick<Worktree, "path" | "branch" | "prBase">,
  title: string,
  body: string,
  isDraft: boolean,
): Promise<{ readonly ok: boolean; readonly url: string | null; readonly detail: string }> {
  if (!wt.prBase) return { ok: false, url: null, detail: `sem branch base para abrir PR (repositório sem commits). Revise o branch ${wt.branch} localmente` };
  const push = await git(wt.path, ["push", "-u", "origin", wt.branch], 120_000);
  if (!push.ok) return { ok: false, url: null, detail: `push falhou: ${firstLine(push.stderr)}` };
  const args = ["pr", "create", "--title", title, "--body", body, "--head", wt.branch, "--base", wt.prBase, ...(isDraft ? ["--draft"] : [])];
  const pr = await run("gh", args, { cwd: wt.path, timeoutMs: 60_000 });
  const url = /https:\/\/\S+\/pull\/\d+/.exec(pr.stdout)?.[0] ?? null;
  return { ok: pr.ok && url !== null, url, detail: firstLine(pr.ok ? pr.stdout : pr.stderr) };
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", worktreePath]);
}
