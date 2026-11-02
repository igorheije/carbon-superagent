import "server-only";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DiffFile } from "@/lib/domain/types";
import { dataDir } from "../db";
import { firstLine, run } from "../proc";
import type { Skill } from "../repo/skills";
import { toSkillMarkdown } from "../skills/parse";

const EXCLUDES = [".claude/skills/carbon-*/", ".codex/skills/carbon-*/", ".carbon/"];
const MAX_DIFF_FILES = 12;
const MAX_SNIPPET_LINES = 8;

export interface Worktree {
  readonly path: string;
  readonly branch: string;
  readonly base: string;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
}

async function git(cwd: string, args: readonly string[], timeoutMs = 60_000) {
  return run("git", args, { cwd, timeoutMs });
}

async function resolveBase(repoPath: string, configured: string): Promise<string> {
  if (configured) return configured;
  const head = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return head.ok ? firstLine(head.stdout) : "main";
}

/** Keeps materialized skills out of commits without touching the repo's .gitignore. */
async function ensureExcludes(worktreePath: string): Promise<void> {
  const common = await git(worktreePath, ["rev-parse", "--git-common-dir"]);
  if (!common.ok) return;
  const infoDir = path.resolve(worktreePath, firstLine(common.stdout), "info");
  const file = path.join(infoDir, "exclude");
  mkdirSync(infoDir, { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = EXCLUDES.filter((line) => !current.includes(line));
  if (missing.length) appendFileSync(file, `\n# carbon: materialized agent skills\n${missing.join("\n")}\n`);
}

export async function prepareWorktree(repoPath: string, baseBranch: string, key: string, taskId: string): Promise<Worktree> {
  const base = await resolveBase(repoPath, baseBranch);
  const branch = `agent/${slug(key)}-${taskId.slice(0, 6)}`;
  const target = path.join(dataDir(), "worktrees", `${slug(key)}-${taskId.slice(0, 6)}`);
  mkdirSync(path.dirname(target), { recursive: true });
  if (!existsSync(target)) {
    const added = await git(repoPath, ["worktree", "add", "-b", branch, target, base]);
    if (!added.ok) throw new Error(`git worktree add falhou: ${firstLine(added.stderr)}`);
  }
  await ensureExcludes(target);
  return { path: target, branch, base };
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

export async function commit(worktreePath: string, message: string): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const email = await git(worktreePath, ["config", "user.email"]);
  const identity = email.ok && email.stdout.trim() ? [] : ["-c", "user.name=Carbon Agent", "-c", "user.email=carbon@localhost"];
  const result = await git(worktreePath, [...identity, "commit", "-m", message]);
  return { ok: result.ok, detail: firstLine(result.ok ? result.stdout : result.stderr) };
}

export async function pushAndOpenPr(
  wt: Worktree,
  title: string,
  body: string,
  isDraft: boolean,
): Promise<{ readonly ok: boolean; readonly url: string | null; readonly detail: string }> {
  const push = await git(wt.path, ["push", "-u", "origin", wt.branch], 120_000);
  if (!push.ok) return { ok: false, url: null, detail: `push falhou: ${firstLine(push.stderr)}` };
  const args = ["pr", "create", "--title", title, "--body", body, "--head", wt.branch, "--base", wt.base, ...(isDraft ? ["--draft"] : [])];
  const pr = await run("gh", args, { cwd: wt.path, timeoutMs: 60_000 });
  const url = /https:\/\/\S+\/pull\/\d+/.exec(pr.stdout)?.[0] ?? null;
  return { ok: pr.ok && url !== null, url, detail: firstLine(pr.ok ? pr.stdout : pr.stderr) };
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", worktreePath]);
}
