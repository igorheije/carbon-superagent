import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NO_COMMITS_REF, type ClaimedTask, type ContextFile } from "@/shared/worker-protocol";

/**
 * Code transport on the worker: get the task's starting point (git clone or panel bundle), give
 * the agent a branch with the context files, then hand the result back (push or bundle).
 *
 * Plain Node on purpose (no server-only, no DB): it runs on pool machines and in AgentCore
 * containers. Every git call goes through execFile with an argument array, never a shell.
 *
 * The git token never appears in argv, in a URL or in .git/config: git asks for it through a
 * GIT_ASKPASS script that only reads an environment variable of that one git process.
 */

/** Same exclusions as the local runner (runner/worktree.ts EXCLUDES): context files stay out of commits. */
const EXCLUDES = [".claude/skills/carbon-*/", ".codex/skills/carbon-*/", ".carbon/"];
/** Ref kept in the clone with the commit the task branch started from (absent for repos without commits). */
const BASE_REF = "refs/carbon/base";
const TOKEN_ENV = "CARBON_GIT_TOKEN";
const DEFAULT_TIMEOUT_MS = 120_000;
const LONG_TIMEOUT_MS = 15 * 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;
/** Settings that apply to every git call: no ext:: transport, no interactive prompts, no signing. */
const SAFE_CONFIG = ["-c", "protocol.ext.allow=never", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface PreparedCode {
  /** Clone root, checked out on `task.code.branch`. */
  readonly path: string;
  /** Commit the task branch starts from; null for a repo without commits (whole branch is delivered). */
  readonly baseCommit: string | null;
}

export interface PrepareOptions {
  /** Base bundle downloaded from the panel (required for transport "bundle"). */
  readonly bundleFile?: string;
  /** Token for an http(s) remote; given to git only through GIT_ASKPASS. */
  readonly gitToken?: string;
}

export interface DeliverOptions {
  readonly gitToken?: string;
  /** When the push is refused, fall back to a bundle instead of failing. */
  readonly allowBundleFallback: boolean;
}

export type Delivery =
  | { readonly transport: "push"; readonly commit: string }
  | { readonly transport: "bundle"; readonly bundleFile: string; readonly commit: string };

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

interface GitCallOptions {
  readonly token?: string;
  readonly timeoutMs?: number;
}

const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? "";

function redact(text: string, token: string | undefined): string {
  return token ? text.split(token).join("***") : text;
}

/** Answers git's Username/Password prompts from the environment; the script itself holds no secret. */
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*|username*) printf '%s\\n' "x-access-token" ;;
  *) printf '%s\\n' "$${TOKEN_ENV}" ;;
esac
`;

/** Runs git with a per-call askpass helper when a token is given. Never throws. */
async function git(cwd: string, args: readonly string[], options: GitCallOptions = {}): Promise<GitResult> {
  const { token } = options;
  const helperDir = token ? mkdtempSync(path.join(tmpdir(), "carbon-askpass-")) : null;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    // Credential helpers must not see (or store) the token: reset the helper list for this call.
    const authConfig = token ? ["-c", "credential.helper="] : [];
    if (helperDir && token) {
      const script = path.join(helperDir, "askpass.sh");
      writeFileSync(script, ASKPASS_SCRIPT, { mode: 0o700 });
      env.GIT_ASKPASS = script;
      env[TOKEN_ENV] = token;
    }
    return await new Promise<GitResult>((resolve) => {
      execFile(
        "git",
        [...SAFE_CONFIG, ...authConfig, ...args],
        { cwd, env, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
        (error, stdout, stderr) => {
          const err = String(stderr || (error && !stderr ? error.message : ""));
          resolve({ ok: !error, stdout: String(stdout), stderr: redact(err, token) });
        },
      );
    });
  } finally {
    if (helperDir) rmSync(helperDir, { recursive: true, force: true });
  }
}

async function gitOrThrow(cwd: string, args: readonly string[], what: string, options: GitCallOptions = {}): Promise<string> {
  const result = await git(cwd, args, options);
  if (!result.ok) throw new Error(`${what}: ${firstLine(result.stderr) || "erro desconhecido do git"}`);
  return result.stdout;
}

async function assertBranchName(branch: string): Promise<void> {
  const check = await git(process.cwd(), ["check-ref-format", "--branch", branch]);
  if (!check.ok || branch.startsWith("-")) throw new Error(`nome de branch inválido: ${branch}`);
}

const cloneDirName = (taskId: string): string => `task-${taskId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "x"}`;

// ---------------------------------------------------------------- prepare

async function cloneFromRemote(code: Extract<ClaimedTask["code"], { transport: "git" }>, target: string, token?: string): Promise<string> {
  const args = ["clone", "--quiet", "--filter=blob:none", "--no-tags", `--branch=${code.baseRef}`, "--", code.remoteUrl, target];
  await gitOrThrow(path.dirname(target), args, "git clone falhou", { token, timeoutMs: LONG_TIMEOUT_MS });
  return firstLine(await gitOrThrow(target, ["rev-parse", "HEAD^{commit}"], "base sem commit"));
}

/** Refs advertised by a bundle: refname → sha. "HEAD" included when present. */
async function bundleHeads(cwd: string, bundleFile: string): Promise<ReadonlyMap<string, string>> {
  const out = await gitOrThrow(cwd, ["bundle", "list-heads", bundleFile], "bundle inválido");
  const entries = out
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length === 2 && /^[0-9a-f]{40,64}$/.test(parts[0] ?? ""))
    .map(([sha, ref]) => [ref, sha] as const);
  return new Map(entries);
}

/**
 * The bundle ref to start from: the base ref as given (full name, branch, remote branch, tag or
 * HEAD). A repo without commits ships its snapshot baseline: the task branch, HEAD or the only ref.
 */
function pickBundleRef(heads: ReadonlyMap<string, string>, baseRef: string, branch: string): string | null {
  const candidates =
    baseRef === NO_COMMITS_REF
      ? [`refs/heads/${branch}`, "HEAD"]
      : [baseRef, `refs/heads/${baseRef}`, `refs/remotes/${baseRef}`, `refs/tags/${baseRef}`];
  for (const ref of candidates) {
    const sha = heads.get(ref);
    if (sha) return sha;
  }
  if (baseRef === NO_COMMITS_REF && heads.size === 1) return [...heads.values()][0] ?? null;
  return null;
}

async function cloneFromBundle(code: ClaimedTask["code"], target: string, bundleFile: string | undefined): Promise<string> {
  if (!bundleFile || !existsSync(bundleFile)) throw new Error("bundle da base não foi baixado");
  const bundle = path.resolve(bundleFile);
  mkdirSync(target, { recursive: true });
  await gitOrThrow(target, ["-c", "init.defaultBranch=carbon-unborn", "init", "--quiet"], "git init falhou");
  const heads = await bundleHeads(target, bundle);
  const sha = pickBundleRef(heads, code.baseRef, code.branch);
  if (!sha) throw new Error(`o bundle não contém a base "${code.baseRef}"`);
  await gitOrThrow(target, ["fetch", "--quiet", "--no-tags", bundle, `+refs/*:refs/carbon/bundle/*`], "git fetch do bundle falhou", { timeoutMs: LONG_TIMEOUT_MS });
  // HEAD is not under refs/*: make sure its commit arrived too.
  if (!(await git(target, ["cat-file", "-e", `${sha}^{commit}`])).ok) {
    await gitOrThrow(target, ["fetch", "--quiet", "--no-tags", bundle, "HEAD"], "git fetch do bundle falhou", { timeoutMs: LONG_TIMEOUT_MS });
  }
  return sha;
}

/** Keeps context files out of commits without touching the repo's .gitignore. */
function writeExcludes(root: string, files: readonly ContextFile[]): void {
  const infoDir = path.join(root, ".git", "info");
  mkdirSync(infoDir, { recursive: true });
  const file = path.join(infoDir, "exclude");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  // Exact, anchored paths for every context file (glob characters escaped) on top of the usual folders.
  const exact = files.map((f) => `/${f.path.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`)}`);
  const lines = [...EXCLUDES, ...exact].filter((line, i, all) => all.indexOf(line) === i && !current.split("\n").includes(line));
  if (lines.length) writeFileSync(file, `${current}${current.endsWith("\n") || !current ? "" : "\n"}# carbon: context files\n${lines.join("\n")}\n`);
}

function isUnsafeRelative(p: string): boolean {
  if (!p || path.isAbsolute(p) || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return true;
  return p.split("/").some((part) => part === ".." || part === ".git");
}

/** Writes context files inside the clone; refuses absolute paths, "..", .git and symlink escapes. */
export function writeContextFiles(root: string, files: readonly ContextFile[]): void {
  const realRoot = realpathSync(root);
  for (const file of files) {
    if (isUnsafeRelative(file.path)) throw new Error(`caminho de arquivo de contexto recusado: ${file.path}`);
    const to = path.resolve(realRoot, file.path);
    if (!to.startsWith(realRoot + path.sep)) throw new Error(`caminho de arquivo de contexto recusado: ${file.path}`);
    mkdirSync(path.dirname(to), { recursive: true });
    const parent = realpathSync(path.dirname(to));
    if (parent !== realRoot && !parent.startsWith(realRoot + path.sep)) throw new Error(`caminho de arquivo de contexto sai do repositório: ${file.path}`);
    if (existsSync(to) && lstatSync(to).isSymbolicLink()) throw new Error(`arquivo de contexto é um link simbólico: ${file.path}`);
    writeFileSync(to, file.content, "utf8");
  }
}

/**
 * Clones the task's starting point into `workDir`, creates `task.code.branch` and writes the
 * context files (excluded from commits). A stale clone of the same task is replaced.
 */
export async function prepareCode(task: ClaimedTask, workDir: string, options: PrepareOptions = {}): Promise<PreparedCode> {
  const { code } = task;
  await assertBranchName(code.branch);
  const unsafe = task.files.find((f) => isUnsafeRelative(f.path));
  if (unsafe) throw new Error(`caminho de arquivo de contexto recusado: ${unsafe.path}`);

  mkdirSync(workDir, { recursive: true });
  const target = path.join(path.resolve(workDir), cloneDirName(task.taskId));
  rmSync(target, { recursive: true, force: true });
  try {
    const start = code.transport === "git" ? await cloneFromRemote(code, target, options.gitToken) : await cloneFromBundle(code, target, options.bundleFile);
    await gitOrThrow(target, ["checkout", "--quiet", "-B", code.branch, start], "não foi possível criar o branch da tarefa");
    const baseCommit = code.baseRef === NO_COMMITS_REF ? null : start;
    if (baseCommit) await gitOrThrow(target, ["update-ref", BASE_REF, baseCommit], "não foi possível marcar a base");
    writeExcludes(target, task.files);
    writeContextFiles(target, task.files);
    return { path: target, baseCommit };
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------- commit

/** Stages everything (context files are excluded) and commits. Null when nothing changed. */
export async function commitAll(repoPath: string, message: string, identity: GitIdentity): Promise<string | null> {
  await gitOrThrow(repoPath, ["add", "-A"], "git add falhou");
  const staged = await git(repoPath, ["diff", "--cached", "--quiet"]);
  if (staged.ok) return null;
  const who = ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
  await gitOrThrow(repoPath, [...who, "commit", "--quiet", "--no-verify", "-m", message], "git commit falhou");
  return firstLine(await gitOrThrow(repoPath, ["rev-parse", "HEAD"], "commit não encontrado"));
}

// ---------------------------------------------------------------- deliver

/** Bundle next to the clone: `<base>..<branch>`, or the whole branch when there is no base commit. */
async function createBundle(repoPath: string, branch: string, head: string): Promise<string> {
  const base = await git(repoPath, ["rev-parse", "--verify", "--quiet", `${BASE_REF}^{commit}`]);
  const baseCommit = base.ok ? firstLine(base.stdout) : null;
  if (baseCommit === head) throw new Error("o branch da tarefa não tem commits novos para entregar");
  const file = `${repoPath}.result.bundle`;
  rmSync(file, { force: true });
  const range = baseCommit ? [`^${baseCommit}`, `refs/heads/${branch}`] : [`refs/heads/${branch}`];
  await gitOrThrow(repoPath, ["bundle", "create", "--quiet", file, ...range], "git bundle create falhou", { timeoutMs: LONG_TIMEOUT_MS });
  return file;
}

/**
 * Hands the task branch back: git transport pushes to origin (bundle when the push is refused and
 * the fallback is allowed); bundle transport writes `<clone>.result.bundle` for upload.
 */
export async function deliverCode(repoPath: string, task: ClaimedTask, options: DeliverOptions): Promise<Delivery> {
  const { branch } = task.code;
  await assertBranchName(branch);
  const commit = firstLine(await gitOrThrow(repoPath, ["rev-parse", `refs/heads/${branch}^{commit}`], "branch da tarefa não encontrado"));
  if (task.code.transport === "git") {
    const ref = `refs/heads/${branch}`;
    const push = await git(repoPath, ["push", "--quiet", "--no-verify", "origin", `${ref}:${ref}`], { token: options.gitToken, timeoutMs: LONG_TIMEOUT_MS });
    if (push.ok) return { transport: "push", commit };
    if (!options.allowBundleFallback) throw new Error(`push falhou: ${firstLine(push.stderr) || "erro desconhecido do git"}`);
  }
  return { transport: "bundle", bundleFile: await createBundle(repoPath, branch, commit), commit };
}

// ---------------------------------------------------------------- cleanup

/** Removes the clone and any result bundle written next to it. */
export function cleanup(repoPath: string): void {
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(`${repoPath}.result.bundle`, { force: true });
}
