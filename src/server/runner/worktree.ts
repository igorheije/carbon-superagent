import "server-only";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { firstLine, run } from "../proc";

const EXCLUDES = [".claude/skills/carbon-*/", ".codex/skills/carbon-*/", ".carbon/"];
/** Common default branch names, tried in order when the configured base does not exist. */
const FALLBACK_BRANCHES = ["main", "master", "develop", "staging"];
const SNAPSHOT_SKIP = new Set([".DS_Store", "Thumbs.db"]);
/** Generated or dependency folders: never part of a snapshot, even without a .gitignore. */
const SNAPSHOT_SKIP_DIRS = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", ".cache", ".turbo",
  "coverage", "target", ".pytest_cache", ".mypy_cache", ".gradle", ".idea", ".git",
]);
/** Bigger files (videos, datasets) stay out of the baseline commit so the repo's .git does not balloon. */
const LARGE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 5_000;
const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;
const MB = 1024 * 1024;
const CARBON_IDENTITY = ["-c", "user.name=Carbon Agent", "-c", "user.email=carbon@localhost"];

export interface Worktree {
  readonly path: string;
  readonly branch: string;
  /** What the worktree was created from (branch, remote branch or commit), for the log. */
  readonly base: string;
  /** Branch to open the PR against, or null when there is none (e.g. a repo without commits). */
  readonly prBase: string | null;
  /** Human-readable notes about recoveries Carbon made (fallback base, reused branch, snapshot...). */
  readonly notes: readonly string[];
}

const git = (cwd: string, args: readonly string[], timeoutMs = 60_000) => run("git", args, { cwd, timeoutMs });

const slug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  return (await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok;
}

async function hasCommits(repoPath: string): Promise<boolean> {
  return refExists(repoPath, "HEAD");
}

interface BaseChoice {
  readonly ref: string;
  readonly prBase: string;
  readonly note: string | null;
}

/**
 * Picks the ref to branch from. Configured base first (local, then origin/), then the branch
 * checked out in the repo, the remote default and the usual names. Never guesses a ref that
 * does not exist: every candidate is verified.
 */
export async function resolveBase(repoPath: string, configured: string): Promise<BaseChoice | null> {
  const wanted = configured.trim();
  const head = await git(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const current = head.ok ? firstLine(head.stdout) : "";
  const remoteHead = await git(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const remoteDefault = remoteHead.ok ? firstLine(remoteHead.stdout).replace(/^origin\//, "") : "";

  const names = [wanted, current, remoteDefault, ...FALLBACK_BRANCHES].filter((n, i, all) => n && all.indexOf(n) === i);
  for (const name of names) {
    for (const ref of [name, `origin/${name}`]) {
      if (!(await refExists(repoPath, ref))) continue;
      const fromRemote = ref !== name;
      const why = !wanted
        ? `base não configurada: usando "${ref}"`
        : name !== wanted
          ? `a base "${wanted}" não existe neste repositório: usando "${ref}". Ajuste em Configurações → projeto.`
          : fromRemote
            ? `"${wanted}" só existe no remoto: usando "${ref}"`
            : null;
      return { ref, prBase: name, note: why };
    }
  }
  if (await hasCommits(repoPath)) {
    return { ref: "HEAD", prBase: current || wanted || "main", note: `nenhuma das bases conhecidas existe: usando o commit atual (HEAD)` };
  }
  return null;
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

async function isWorktree(dir: string): Promise<boolean> {
  return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).ok;
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  return (await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
}

/** Adds the worktree, reusing the task branch when an earlier attempt already created it. */
async function addWorktree(repoPath: string, target: string, branch: string, baseRef: string, notes: string[]): Promise<void> {
  if (await branchExists(repoPath, branch)) {
    const reused = await git(repoPath, ["worktree", "add", target, branch]);
    if (reused.ok) return void notes.push(`branch ${branch} de uma tentativa anterior reaproveitado`);
    throw new Error(`git worktree add falhou: ${firstLine(reused.stderr)}`);
  }
  const added = await git(repoPath, ["worktree", "add", "-b", branch, target, baseRef]);
  if (!added.ok) throw new Error(`git worktree add falhou: ${firstLine(added.stderr)}`);
}

/**
 * A repo without any commit has nothing to branch from. Carbon creates an orphan branch in a
 * worktree and copies the working files (respecting .gitignore) as a baseline commit, so the
 * agent sees the project and the diff shows only its changes. The repo's own branch is untouched.
 */
async function snapshotUnborn(repoPath: string, target: string, branch: string, notes: string[]): Promise<void> {
  const listed = await git(repoPath, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (!listed.ok) throw new Error(`não foi possível listar os arquivos do projeto: ${firstLine(listed.stderr)}`);
  const { copy, large } = planSnapshot(repoPath, listed.stdout.split("\0"));
  if (copy.length === 0) throw new Error("o repositório não tem commits nem arquivos: adicione arquivos ao projeto antes de criar tarefas");
  const copyBytes = copy.reduce((sum, f) => sum + f.size, 0);
  if (copy.length > MAX_SNAPSHOT_FILES || copyBytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      `o repositório não tem commits e tem ${copy.length} arquivos (${Math.round(copyBytes / MB)} MB) fora de pastas geradas; o limite da cópia automática é ${MAX_SNAPSHOT_FILES} arquivos / ${MAX_SNAPSHOT_BYTES / MB} MB. Crie um .gitignore e um commit inicial (git add -A && git commit -m "initial") e tente de novo`,
    );
  }

  const reusing = await branchExists(repoPath, branch);
  const added = await git(repoPath, reusing ? ["worktree", "add", target, branch] : ["worktree", "add", "--orphan", "-b", branch, target]);
  if (!added.ok) throw new Error(`git worktree add falhou: ${firstLine(added.stderr)}`);
  if (reusing) return void notes.push(`branch ${branch} de uma tentativa anterior reaproveitado`);

  for (const { file } of copy) {
    const to = path.join(target, file);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(path.join(repoPath, file), to);
  }
  await git(target, ["add", "-A"]);
  const baseline = await git(target, [...CARBON_IDENTITY, "commit", "--no-verify", "-m", "chore: baseline snapshot of uncommitted project (Carbon)"]);
  if (!baseline.ok) throw new Error(`não foi possível criar o snapshot inicial: ${firstLine(baseline.stderr)}`);
  if (large.length > 0) writeOmittedList(target, repoPath, large);
  notes.push(`repositório sem commits: criado o branch ${branch} com uma cópia de ${copy.length} arquivos como base. O seu branch não foi alterado.`);
  if (large.length > 0) {
    const mb = Math.round(large.reduce((sum, f) => sum + f.size, 0) / MB);
    notes.push(`${large.length} arquivo(s) grande(s) (${mb} MB, ex.: ${large[0]?.file}) ficaram fora da cópia; lista em .carbon/OMITTED_FILES.md`);
  }
}

interface SnapshotFile {
  readonly file: string;
  readonly size: number;
}

/** Splits the listed files into what gets copied and what is too large to snapshot. */
function planSnapshot(repoPath: string, listed: readonly string[]): { copy: readonly SnapshotFile[]; large: readonly SnapshotFile[] } {
  const files = listed
    .filter((f) => f && !SNAPSHOT_SKIP.has(path.basename(f)) && !f.split("/").some((part) => SNAPSHOT_SKIP_DIRS.has(part)))
    .flatMap((file) => {
      const from = path.join(repoPath, file);
      if (!existsSync(from)) return [];
      const stat = statSync(from);
      return stat.isFile() ? [{ file, size: stat.size }] : [];
    });
  return { copy: files.filter((f) => f.size <= LARGE_FILE_BYTES), large: files.filter((f) => f.size > LARGE_FILE_BYTES) };
}

function writeOmittedList(target: string, repoPath: string, large: readonly SnapshotFile[]): void {
  const dir = path.join(target, ".carbon");
  mkdirSync(dir, { recursive: true });
  const rows = large.map((f) => `- ${f.file} (${(f.size / MB).toFixed(1)} MB)`).join("\n");
  writeFileSync(
    path.join(dir, "OMITTED_FILES.md"),
    `# Arquivos fora do snapshot\n\nGrandes demais para a cópia de base (> ${LARGE_FILE_BYTES / MB} MB). Os originais, somente leitura, estão em ${repoPath}.\n\n${rows}\n`,
    "utf8",
  );
}

/** Folder and branch suffix for a task: "<key>-<first 6 chars of the id>". */
export const worktreeName = (key: string, taskId: string): string => `${slug(key)}-${taskId.slice(0, 6)}`;

export type ReleaseResult = "removed" | "dirty" | "missing" | "error";

/**
 * Removes a task's worktree once the work is safe in its branch. Uncommitted changes are never
 * thrown away: a dirty worktree stays. The branch always stays.
 */
export async function releaseWorktree(repoPath: string, worktreePath: string): Promise<ReleaseResult> {
  if (!worktreePath || !existsSync(worktreePath)) {
    await git(repoPath, ["worktree", "prune"]);
    return "missing";
  }
  const status = await git(worktreePath, ["status", "--porcelain"]);
  if (!status.ok) return "error";
  if (status.stdout.trim()) return "dirty";
  // --force only drops ignored Carbon files (.carbon/, materialized skills); the tree is clean.
  const removed = await git(repoPath, ["worktree", "remove", "--force", worktreePath]);
  await git(repoPath, ["worktree", "prune"]);
  return removed.ok ? "removed" : "error";
}

export async function prepareWorktree(repoPath: string, baseBranch: string, key: string, taskId: string, root: string): Promise<Worktree> {
  const name = worktreeName(key, taskId);
  const branch = `agent/${name}`;
  const target = path.join(root, name);
  const notes: string[] = [];
  mkdirSync(root, { recursive: true });
  // Registrations whose folder was deleted would block "worktree add" for the same branch.
  await git(repoPath, ["worktree", "prune"]);

  const base = await resolveBase(repoPath, baseBranch);
  const prBase = base?.prBase ?? null;
  const baseLabel = base?.ref ?? "(sem commits)";
  if (base?.note) notes.push(base.note);

  if (existsSync(target)) {
    if (await isWorktree(target)) {
      await ensureExcludes(target);
      return { path: target, branch, base: baseLabel, prBase, notes };
    }
    const aside = `${target}.stale-${Date.now()}`;
    renameSync(target, aside);
    notes.push(`pasta de worktree inválida movida para ${path.basename(aside)}`);
  }

  if (base) await addWorktree(repoPath, target, branch, base.ref, notes);
  else await snapshotUnborn(repoPath, target, branch, notes);
  await ensureExcludes(target);
  return { path: target, branch, base: baseLabel, prBase, notes };
}
