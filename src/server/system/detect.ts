import "server-only";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ExecutorAvailability } from "../executors/resolve";
import { firstLine, run } from "../proc";

/** optional = not installed, but not needed (e.g. Codex when Claude Code is present). */
export type CheckStatus = "ok" | "warn" | "missing" | "optional";

export interface Check {
  readonly id: "node" | "git" | "gh" | "claude" | "codex" | "repo";
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix: string | null;
}

const MIN_NODE: readonly [number, number] = [22, 13];

function checkNode(): Check {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const isOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    id: "node",
    label: "Node.js",
    status: isOk ? "ok" : "missing",
    detail: `v${process.versions.node}`,
    fix: isOk ? null : "nvm install 22 && nvm use 22",
  };
}

async function checkBinary(
  id: "git" | "gh" | "claude" | "codex",
  label: string,
  versionArgs: readonly string[],
  fix: string,
): Promise<Check> {
  const result = await run(id, versionArgs, { timeoutMs: 10_000 });
  return result.ok
    ? { id, label, status: "ok", detail: firstLine(result.stdout || result.stderr), fix: null }
    : { id, label, status: "missing", detail: "não encontrado no PATH", fix };
}

async function checkGhAuth(base: Check): Promise<Check> {
  if (base.status !== "ok") return { ...base, status: "optional", detail: "opcional · sem gh o Carbon só faz commit local", fix: "brew install gh && gh auth login" };
  const auth = await run("gh", ["auth", "status"], { timeoutMs: 10_000 });
  return auth.ok
    ? { ...base, detail: `${base.detail} · autenticado` }
    : { ...base, status: "warn", detail: `${base.detail} · não autenticado`, fix: "gh auth login" };
}

async function checkCodexAuth(base: Check): Promise<Check> {
  if (base.status !== "ok") return base;
  const auth = await run("codex", ["login", "status"], { timeoutMs: 10_000 });
  const text = `${auth.stdout}\n${auth.stderr}`;
  return auth.ok && /logged in/i.test(text)
    ? { ...base, detail: `${base.detail} · ${firstLine(text)}` }
    : { ...base, status: "warn", detail: `${base.detail} · login não confirmado`, fix: "codex login" };
}

export function checkRepo(repoPath: string): Check {
  if (!repoPath) return { id: "repo", label: "Repositório", status: "missing", detail: "nenhum repositório configurado", fix: null };
  const resolved = path.resolve(repoPath);
  const isDir = existsSync(resolved) && statSync(resolved).isDirectory();
  const isGit = isDir && existsSync(path.join(resolved, ".git"));
  return isGit
    ? { id: "repo", label: "Repositório", status: "ok", detail: resolved, fix: null }
    : { id: "repo", label: "Repositório", status: "missing", detail: `${resolved} não é um repositório git`, fix: null };
}

/**
 * Carbon needs ONE executor. When one is installed, the missing one is shown as
 * optional (neutral), not as an error. Only when both are missing do both turn red.
 */
export function pairExecutors(claude: Check, codex: Check): readonly [Check, Check] {
  const hasClaude = claude.status !== "missing";
  const hasCodex = codex.status !== "missing";
  if (hasClaude === hasCodex) return [claude, codex];
  const asOptional = (c: Check, present: string): Check => ({ ...c, status: "optional", detail: `não instalado · opcional (${present} já atende)` });
  return hasClaude ? [claude, asOptional(codex, "Claude Code")] : [asOptional(claude, "Codex"), codex];
}

/** Machine readiness. Claude Code auth is validated by its first run (no cheap status command). */
export async function runChecks(repoPath: string): Promise<readonly Check[]> {
  const [git, gh, claudeBin, codexBin] = await Promise.all([
    checkBinary("git", "Git", ["--version"], "brew install git"),
    checkBinary("gh", "GitHub CLI", ["--version"], "brew install gh && gh auth login"),
    checkBinary("claude", "Claude Code", ["--version"], "npm i -g @anthropic-ai/claude-code && claude (login com seu plano)"),
    checkBinary("codex", "Codex CLI", ["--version"], "npm i -g @openai/codex && codex login"),
  ]);
  const [claude, codex] = pairExecutors(claudeBin, await checkCodexAuth(codexBin));
  return [checkNode(), git, await checkGhAuth(gh), claude, codex, checkRepo(repoPath)];
}

export function hasAnyExecutor(checks: readonly Check[]): boolean {
  return checks.some((c) => (c.id === "claude" || c.id === "codex") && (c.status === "ok" || c.status === "warn"));
}

const EXECUTOR_CACHE_MS = 30_000;
let executorCache: { at: number; value: ExecutorAvailability } | null = null;

/** Which agent CLIs are on PATH right now (cached briefly; called on every task creation). */
export async function detectExecutors(): Promise<ExecutorAvailability> {
  if (executorCache && Date.now() - executorCache.at < EXECUTOR_CACHE_MS) return executorCache.value;
  const [claude, codex] = await Promise.all([
    run("claude", ["--version"], { timeoutMs: 10_000 }),
    run("codex", ["--version"], { timeoutMs: 10_000 }),
  ]);
  const value = { claude: claude.ok, codex: codex.ok };
  executorCache = { at: Date.now(), value };
  return value;
}
