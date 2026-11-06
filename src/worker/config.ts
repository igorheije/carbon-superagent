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
 * | CARBON_GIT_HOSTS              | no       | —  (hosts that may get the git token; empty = token never sent) |
 * | CARBON_WORKER_GRACE_SECONDS   | no       | 120 (0..3600, wait on SIGTERM)   |
 *
 * Tokens are validated but never echoed back in errors or logs. After reading, main.ts removes
 * them from process.env (scrubSecretEnv) so nothing spawned later inherits them.
 *
 * The panel URL must be https unless it points to this machine (loopback): the worker token
 * travels in every request.
 */

export interface WorkerConfig {
  readonly panelUrl: string;
  readonly token: string;
  readonly parallel: number;
  readonly executors: readonly ExecutorId[];
  readonly workDir: string;
  readonly gitToken: string | undefined;
  /** Hostnames (lowercase, optional :port) the git token may be sent to. */
  readonly gitHosts: readonly string[];
  readonly graceSeconds: number;
}

/** Environment variables holding secrets the worker reads once and then removes. */
export const SECRET_ENV_NAMES = ["CARBON_WORKER_TOKEN", "CARBON_GIT_TOKEN"] as const;

/** Deletes the worker/git tokens from `env` (process.env at startup) after the config is read. */
export function scrubSecretEnv(env: Record<string, string | undefined>): void {
  for (const name of SECRET_ENV_NAMES) delete env[name];
}

// ---------------------------------------------------------------- URL / host safety

const stripBrackets = (host: string): string => host.replace(/^\[|\]$/g, "").toLowerCase();

function ipv4Parts(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  return nums.every((n) => n <= 255) ? nums : null;
}

/** "::ffff:a.b.c.d" or WHATWG-normalized "::ffff:xxxx:yyyy" → "a.b.c.d". */
function mappedIpv4(host: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted?.[1]) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex?.[1] || !hex[2]) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** localhost, 127.0.0.0/8 or ::1 (also IPv4-mapped 127.x). */
export function isLoopbackHost(hostname: string): boolean {
  const host = stripBrackets(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const v4 = ipv4Parts(mappedIpv4(host) ?? host);
  return v4 !== null && v4[0] === 127;
}

/**
 * IP literals that are not routable on the internet: RFC 1918, CGNAT, link-local (cloud metadata
 * 169.254.169.254), unspecified, IPv6 ULA/link-local and IPv4-mapped forms of those.
 * Hostnames are not resolved here (DNS can still point anywhere: document, don't trust).
 */
export function isPrivateHost(hostname: string): boolean {
  const host = stripBrackets(hostname);
  if (isLoopbackHost(host)) return true;
  const v4 = ipv4Parts(mappedIpv4(host) ?? host);
  if (v4) {
    const [a = 0, b = 0] = v4;
    return a === 0 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!host.includes(":")) return false;
  return host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

export interface PanelUrlRules {
  /** Refuse private / link-local IP literals (AgentCore: the URL arrives in an invocation). */
  readonly rejectPrivate?: boolean;
}

/**
 * Validates a panel URL: http(s), no credentials, https unless loopback; optionally no private IPs
 * (loopback is still accepted for local development). Returns an error message or the normalized URL.
 */
export function checkPanelUrl(raw: string, rules: PanelUrlRules = {}): { ok: true; url: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "precisa ser uma URL http(s) válida" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "precisa ser uma URL http(s) válida" };
  if (url.username || url.password) return { ok: false, error: "não pode conter usuário/senha" };
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && !loopback) return { ok: false, error: "precisa usar https (http só para 127.0.0.1/localhost)" };
  if (rules.rejectPrivate && !loopback && isPrivateHost(url.hostname)) return { ok: false, error: "não pode apontar para IP privado ou link-local" };
  return { ok: true, url: url.toString().replace(/\/+$/, "") };
}

/** CARBON_GIT_HOSTS: comma-separated hostnames (optionally host:port), lowercase. */
export function parseGitHosts(raw: string | undefined, errors: string[]): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const hosts = raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const bad = hosts.filter((h) => !/^[a-z0-9.-]+(:\d{1,5})?$/.test(h));
  if (bad.length > 0) errors.push("CARBON_GIT_HOSTS aceita apenas nomes de host separados por vírgula (ex.: github.com,gitlab.com)");
  return [...new Set(hosts.filter((h) => !bad.includes(h)))];
}

/**
 * The git token for `remoteUrl`, or undefined when the remote's host is not allowlisted (or the
 * remote is not https). An agent-controlled or panel-controlled URL can then never receive it.
 */
export function gitTokenFor(remoteUrl: string, token: string | undefined, hosts: readonly string[]): string | undefined {
  if (!token || hosts.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase();
  const withPort = url.port ? `${host}:${url.port}` : host;
  return hosts.includes(host) || hosts.includes(withPort) ? token : undefined;
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
  const checked = checkPanelUrl(raw);
  if (checked.ok) return checked.url;
  errors.push(`CARBON_PANEL_URL ${checked.error}`);
  return "";
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
  if (!token) errors.push("CARBON_WORKER_TOKEN é obrigatório (gere em Configurações → Máquinas)");
  else if (/\s/.test(token) || !token.startsWith("cwk_")) errors.push("CARBON_WORKER_TOKEN inválido (deve começar com cwk_)");
  const parallel = intInRange(env.CARBON_WORKER_PARALLEL, "CARBON_WORKER_PARALLEL", 1, MAX_PARALLEL, DEFAULT_PARALLEL, errors);
  const graceSeconds = intInRange(env.CARBON_WORKER_GRACE_SECONDS, "CARBON_WORKER_GRACE_SECONDS", 0, MAX_GRACE_SECONDS, DEFAULT_GRACE_SECONDS, errors);
  const executors = executorsOf(env.CARBON_WORKER_EXECUTORS, detect, errors);
  const workDir = path.resolve(env.CARBON_WORKER_DIR?.trim() || path.join(tmpdir(), "carbon-worker"));
  const gitToken = env.CARBON_GIT_TOKEN?.trim() || undefined;
  const gitHosts = parseGitHosts(env.CARBON_GIT_HOSTS, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { panelUrl, token, parallel, executors, workDir, gitToken, gitHosts, graceSeconds } };
}
