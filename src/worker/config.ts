import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutorId } from "../shared/executors";

/**
 * Worker configuration from the environment (`carbon worker`, Docker, Kubernetes):
 *
 * | Variable                      | Required | Default                          |
 * |-------------------------------|----------|----------------------------------|
 * | CARBON_PANEL_URL              | yes      | —  (http(s) URL of the panel)    |
 * | CARBON_WORKER_TOKEN           | yes      | —  (cwk_… token from the panel)  |
 * | CARBON_WORKER_PARALLEL        | no       | 1  (1..64 tasks at once)         |
 * | CARBON_WORKER_EXECUTORS       | no       | detected: `claude --version`, `codex --version` |
 * | CARBON_WORKER_DIR             | no       | <os tmpdir>/carbon-worker        |
 * | CARBON_GIT_TOKEN              | no       | —  (push/clone over https)       |
 * | CARBON_WORKER_GRACE_SECONDS   | no       | 120 (0..3600, wait on SIGTERM)   |
 *
 * Tokens are validated but never echoed back in errors or logs.
 */

export interface WorkerConfig {
  readonly panelUrl: string;
  readonly token: string;
  readonly parallel: number;
  readonly executors: readonly ExecutorId[];
  readonly workDir: string;
  readonly gitToken: string | undefined;
  readonly graceSeconds: number;
}

export type ConfigResult = { readonly ok: true; readonly config: WorkerConfig } | { readonly ok: false; readonly errors: readonly string[] };

export const DEFAULT_PARALLEL = 1;
export const MAX_PARALLEL = 64;
export const DEFAULT_GRACE_SECONDS = 120;
export const MAX_GRACE_SECONDS = 3600;
const KNOWN_EXECUTORS: readonly ExecutorId[] = ["claude", "codex"];

/** Executors whose CLI answers `--version` on this machine. */
export function detectExecutors(): readonly ExecutorId[] {
  return KNOWN_EXECUTORS.filter((bin) => spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000 }).status === 0);
}

function intInRange(raw: string | undefined, name: string, min: number, max: number, fallback: number, errors: string[]): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} precisa ser um inteiro entre ${min} e ${max}`);
    return fallback;
  }
  return value;
}

function panelUrlOf(raw: string | undefined, errors: string[]): string {
  if (!raw?.trim()) {
    errors.push("CARBON_PANEL_URL é obrigatório (ex.: https://carbon.minha-rede.local)");
    return "";
  }
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocolo");
    if (url.username || url.password) {
      errors.push("CARBON_PANEL_URL não pode conter usuário/senha");
      return "";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    errors.push("CARBON_PANEL_URL precisa ser uma URL http(s) válida");
    return "";
  }
}

function executorsOf(raw: string | undefined, detect: () => readonly ExecutorId[], errors: string[]): readonly ExecutorId[] {
  if (raw === undefined || raw.trim() === "") {
    const found = detect();
    if (found.length === 0) errors.push("nenhum executor encontrado (instale claude ou codex) — ou defina CARBON_WORKER_EXECUTORS");
    return found;
  }
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !KNOWN_EXECUTORS.includes(n as ExecutorId));
  if (unknown.length > 0 || names.length === 0) {
    errors.push(`CARBON_WORKER_EXECUTORS aceita apenas ${KNOWN_EXECUTORS.join(", ")} (separados por vírgula)`);
    return [];
  }
  return [...new Set(names as ExecutorId[])];
}

/** Reads and validates the worker environment. `detect` is only called when executors are not set. */
export function readWorkerConfig(env: Readonly<Record<string, string | undefined>>, detect: () => readonly ExecutorId[] = detectExecutors): ConfigResult {
  const errors: string[] = [];
  const panelUrl = panelUrlOf(env.CARBON_PANEL_URL, errors);
  const token = env.CARBON_WORKER_TOKEN?.trim() ?? "";
  if (!token) errors.push("CARBON_WORKER_TOKEN é obrigatório (gere em Admin → Máquinas)");
  else if (/\s/.test(token) || !token.startsWith("cwk_")) errors.push("CARBON_WORKER_TOKEN inválido (deve começar com cwk_)");
  const parallel = intInRange(env.CARBON_WORKER_PARALLEL, "CARBON_WORKER_PARALLEL", 1, MAX_PARALLEL, DEFAULT_PARALLEL, errors);
  const graceSeconds = intInRange(env.CARBON_WORKER_GRACE_SECONDS, "CARBON_WORKER_GRACE_SECONDS", 0, MAX_GRACE_SECONDS, DEFAULT_GRACE_SECONDS, errors);
  const executors = executorsOf(env.CARBON_WORKER_EXECUTORS, detect, errors);
  const workDir = path.resolve(env.CARBON_WORKER_DIR?.trim() || path.join(tmpdir(), "carbon-worker"));
  const gitToken = env.CARBON_GIT_TOKEN?.trim() || undefined;
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { panelUrl, token, parallel, executors, workDir, gitToken, graceSeconds } };
}
